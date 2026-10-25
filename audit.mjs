#!/usr/bin/env node
// Pre-submit audit. Re-reads every artefact from disk and asserts that (a) each
// run actually succeeded, (b) every number quoted in the delivery is the number
// the artefact contains, and (c) the analysis' first_bottleneck for each
// endpoint really is the top APPLICATION frame of that endpoint's own profile.
//
// This is the script that exists because a previous delivery quoted rps/p50 from
// runs whose success count was 0. A run with zero successful requests is not a
// measurement, and this file refuses to let one through.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNS = path.join(HERE, 'runs');
const R = (f) => JSON.parse(fs.readFileSync(path.join(RUNS, f), 'utf8'));

let pass = 0, fail = 0;
const ok = (cond, label, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ' -- ' + detail : ''}`); }
};

console.log('== 1. every run produced data ==');
const knee = R('knee.json');
ok(knee.endpoints.length === 4, 'knee covers 4 endpoints', `got ${knee.endpoints.length}`);
for (const e of knee.endpoints) {
  ok(e.errors === 0, `knee ${e.endpoint}: zero errors`, `errors=${e.errors}`);
  const totalReq = e.conns.reduce((a, c) => a + c.total, 0);
  const totalOk = e.conns.reduce((a, c) => a + c.ok, 0);
  ok(totalReq > 0 && totalOk > 0, `knee ${e.endpoint}: produced successful requests`, `total=${totalReq} ok=${totalOk}`);
  // Every stage must have succeeded, not just the sum: one dead stage would
  // quietly drag the average down and still look like a number.
  ok(e.conns.every((c) => c.ok === c.total), `knee ${e.endpoint}: every concurrency stage fully succeeded`,
     e.conns.filter((c) => c.ok !== c.total).map((c) => `conn${c.conn}:${c.ok}/${c.total}`).join(','));
  // A knee claimed above the best observed rps is nonsense.
  ok(e.rps_sustained <= e.peak_rps + 0.01, `knee ${e.endpoint}: sustained <= peak`);
}

const cpu = R('cpu-per-endpoint.json');
ok(cpu.endpoints.length === 4, 'cpu profile covers 4 endpoints');
for (const e of cpu.endpoints) {
  const nonOk = Object.entries(e.http_codes).filter(([k]) => k !== '200').reduce((a, [, v]) => a + v, 0);
  ok(nonOk === 0, `profile ${e.endpoint}: all 200 (not a rate-limit profile)`, JSON.stringify(e.http_codes));
  ok(e.total_self_ms > 0 && e.frames_captured > 0, `profile ${e.endpoint}: non-empty`);
}

const sql = R('count-sql.json');
ok(sql.results.length === 4, 'sql count covers 4 endpoints');
for (const s of sql.results) ok(s.statements_per_request > 0, `sql ${s.endpoint}: counted > 0`);

const rs = R('row-scaling.json');
const distinct = new Set(rs.rows.map((r) => r.rows_returned));
ok(distinct.size >= 3, 'row-scaling actually varied the row count', [...distinct].join(','));
ok(rs.timeFit.slope > 0, 'row-scaling slope positive (cost grows with rows)');

const ws = R('write-scenario.json');
ok(ws.results.length >= 1, 'write scenario produced stages');
for (const r of ws.results) {
  const all = r.stages.flatMap((s) => Object.entries(s.codes));
  const un = all.filter(([k]) => k === '401').reduce((a, [, v]) => a + v, 0);
  const tot = all.reduce((a, [, v]) => a + v, 0);
  ok(un / tot < 0.1, `write ${r.stage}: auth passed (not 401-bound)`, `${un}/${tot}`);
}

console.log('\n== 2. analysis numbers come from the artefacts ==');
const an = R('analysis.json');
for (const pe of an.per_endpoint) {
  const k = knee.endpoints.find((x) => x.endpoint === pe.name);
  const s = sql.results.find((x) => x.endpoint === pe.name);
  ok(pe.rps_sustained === k.rps_sustained, `analysis rps matches knee (${pe.name})`);
  ok(pe.p50_ms === k.p50_ms, `analysis p50 matches knee (${pe.name})`);
  ok(pe.sql_per_request === s.statements_per_request, `analysis sql count matches (${pe.name})`);
}

console.log('\n== 3. first_bottleneck is the top APPLICATION frame of its OWN profile ==');
// Recompute independently from the raw profile, not from analysis.json.
function classify(fn) {
  const at = fn.lastIndexOf(' @ ');
  const url = at >= 0 ? fn.slice(at + 3).replace(/:\d+$/, '') : '';
  if (!url) return 'native';
  if (url.startsWith('node:')) return 'internal';
  if (/\/node_modules\//.test(url)) return 'dependency';
  return 'app';
}
for (const pe of an.per_endpoint) {
  const e = cpu.endpoints.find((x) => x.endpoint === pe.name);
  const appRows = e.complete_self_time_table.filter((r) => ['app', 'dependency'].includes(classify(r.fn)));
  ok(appRows.length > 0, `profile ${pe.name}: has application frames`);
  if (!appRows.length) continue;
  // Compare on the FUNCTION NAME and the path TAIL: analysis.json shortens
  // paths for readability, so a full-URL string comparison would always fail.
  const top = appRows[0];
  const topName = top.fn.slice(0, top.fn.indexOf(' @ '));
  const topFile = top.fn.split('/').pop().replace(/:\d+$/, '');   // e.g. service.ts
  const quotedName = pe.first_bottleneck.slice(0, pe.first_bottleneck.indexOf(' @ '));
  ok(quotedName === topName, `first_bottleneck(${pe.name}) names the real top app frame`,
     `quoted="${quotedName}" real="${topName}"`);
  ok(pe.first_bottleneck.includes(topFile), `first_bottleneck(${pe.name}) cites the right source file`,
     `expected file "${topFile}" in "${pe.first_bottleneck.slice(0, 90)}"`);
  // And it must be that endpoint's own table: the quoted pct must equal the pct
  // recomputed from the raw profile, re-ranked independently here.
  const appTotal = e.complete_self_time_table
    .filter((r) => ['app', 'dependency'].includes(classify(r.fn)))
    .reduce((a, r) => a + r.self_pct, 0);
  const recomputed = +((top.self_pct / appTotal) * 100).toFixed(2);
  ok(pe.first_bottleneck_pct_of_app === recomputed, `first_bottleneck pct(${pe.name}) recomputes`,
     `quoted=${pe.first_bottleneck_pct_of_app} recomputed=${recomputed}`);
}

console.log('\n== 4. settled is covered (it was missing entirely before) ==');
const settled = an.per_endpoint.find((p) => p.name === 'settled');
ok(!!settled, 'settled present in per_endpoint');
ok(!!knee.endpoints.find((e) => e.endpoint === 'settled'), 'settled has a knee sweep');
ok(!!cpu.endpoints.find((e) => e.endpoint === 'settled'), 'settled has its own profile');
ok(settled && settled.sql_per_request > 0, 'settled SQL statements counted', String(settled?.sql_per_request));

console.log('\n== 5. reviewer point 4: detail must NOT be attributed to all() ==');
const detail = an.per_endpoint.find((p) => p.name === 'detail');
ok(detail && !/all\(\)/.test(detail.first_bottleneck), 'detail bottleneck is not adapter all()', detail?.first_bottleneck.slice(0, 80));
const detailSql = sql.results.find((x) => x.endpoint === 'detail');
ok(detailSql.statements_per_request === 4, 'detail prepares 4 statements (matches reviewer)', `got ${detailSql.statements_per_request}`);

console.log('\n== 6. delivery payload integrity ==');
const payloadPath = path.join(HERE, 'submission.json');
if (fs.existsSync(payloadPath)) {
  const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
  ok(payload.submission_content.length <= 50000, 'submission_content within 50000 chars', `${payload.submission_content.length}`);
  const inner = JSON.parse(payload.submission_content);
  let trunc = 0;
  for (const [name, f] of Object.entries(inner.files || {})) {
    // The builder's real marker is "[truncated N chars; ...]"; matching only
    // that (not the bare word) keeps this detector from flagging its own
    // source line, which is what a looser pattern used to do.
    if (/\[truncated \d+ chars/.test(f.content || '')) { trunc++; console.log(`       truncated: ${name}`); }
  }
  ok(trunc === 0, 'no file content is truncated', `${trunc} truncated`);
  for (const [name, f] of Object.entries(inner.files || {})) {
    const c = f.content || '';
    if (/\.(mjs|js)$/.test(name)) ok(c.length > 0, `${name}: non-empty`);
  }
  // sha256 of every inlined file must match what we claim
  let mism = 0;
  for (const [name, f] of Object.entries(inner.files || {})) {
    if (!f.sha256) continue;
    const h = crypto.createHash('sha256').update(f.content || '').digest('hex');
    if (h !== f.sha256) { mism++; console.log(`       sha mismatch: ${name}`); }
  }
  ok(mism === 0, 'every inlined file sha256 matches its content', `${mism} mismatched`);
  const aw = (inner.analysis || '').trim().split(/\s+/).length;
  ok(aw <= 600, `analysis <= 600 words`, `${aw}`);
} else {
  console.log('  (submission.json not built yet -- run build-submission.mjs)');
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);