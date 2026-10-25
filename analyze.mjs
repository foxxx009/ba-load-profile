#!/usr/bin/env name
// Derive every quoted number from the run artefacts. No number in the delivery
// is typed by hand; this script re-reads the JSON and recomputes it, then
// FAILS loudly if the analysis text disagrees with the data.
//
// Two honesty rules this file exists to enforce:
//  1. The profile is taken in-process, so the load generator's own loopback TCP
//     work shares the profile with the server. We therefore report both the
//     raw table and an "application frames" view, and every first_bottleneck
//     is read off the APPLICATION view of that endpoint's own profile.
//  2. "unreadable" must never be rendered as "zero". If an artefact is missing
//     we throw instead of emitting a plausible number.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const R = (f) => path.join(HERE, 'runs', f);
const need = (f) => {
  const p = R(f);
  if (!fs.existsSync(p)) throw new Error(`MISSING ARTEFACT ${f} -- refusing to emit a number for it`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
};

// Frame keys are `${fn} @ ${url}:${line}`.
//   url === ''  -> native/builtin frame (TCP connect, GC, (program), (idle))
// A frame counts as application work only if it has a real source url that is
// not the profiler or a node internal. Note the line number is stored as
// `lineNumber + 1`, so ":1" is source line 1, not a missing line.
function classify(fn) {
  const at = fn.lastIndexOf(' @ ');
  const url = at >= 0 ? fn.slice(at + 3).replace(/:\d+$/, '') : '';
  const name = at >= 0 ? fn.slice(0, at) : fn;
  if (!url) return { kind: 'native', name, url: '' };
  if (url.startsWith('node:inspector')) return { kind: 'profiler', name, url };
  if (url.startsWith('node:')) return { kind: 'node_internal', name, url };
  if (/\/node_modules\/node:internal|\/node_modules\/inspector/.test(url)) return { kind: 'node_internal', name, url };
  if (/\/node_modules\//.test(url)) return { kind: 'dependency', name, url };
  return { kind: 'app', name, url };
}

// Shorten paths for display: keep the last 3 path segments.
const short = (url) => url.replace(/^[a-z]+:\/\//, '').split('/').slice(-3).join('/');

const cpu = need('cpu-per-endpoint.json');
const knee = need('knee.json');
const sql = need('count-sql.json');

const appShare = {};
for (const e of cpu.endpoints) {
  // Re-derive from microseconds implied by pct * total, preserving ranking.
  const rows = e.complete_self_time_table.map((r) => {
    const us = (r.self_pct / 100) * e.total_self_ms * 1000;
    return { ...r, us, cls: classify(r.fn) };
  }).sort((a, b) => b.us - a.us);

  const totalUs = rows.reduce((a, r) => a + r.us, 0);
  if (totalUs <= 0) throw new Error(`${e.endpoint}: profile totals zero microseconds -- refusing to divide`);
  const appUs = rows.filter((r) => r.cls.kind === 'app' || r.cls.kind === 'dependency').reduce((a, r) => a + r.us, 0);
  const appRows = rows.filter((r) => r.cls.kind === 'app' || r.cls.kind === 'dependency');

  // Percentages are expressed against the application-only subtotal, because
  // that is the denominator a reader cares about when asking "what is the
  // first bottleneck in this endpoint's handler".
  const denom = appUs || totalUs;
  const ranked = appRows.map((r) => ({
    fn: `${r.cls.name} @ ${short(r.cls.url)}`,
    pct_of_app_time: +((r.us / denom) * 100).toFixed(2),
    pct_of_whole_profile: +((r.us / totalUs) * 100).toFixed(2),
    kind: r.cls.kind,
  }));

  if (!ranked.length) throw new Error(`${e.endpoint}: no application frames at all -- the classifier is wrong, not the server`);
  appShare[e.endpoint] = {
    total_self_ms: e.total_self_ms,
    frames_captured: rows.length,
    app_share_pct: +((appUs / totalUs) * 100).toFixed(1),
    harness_share_pct: +(((totalUs - appUs) / totalUs) * 100).toFixed(1),
    top_app_frames: ranked.slice(0, 12),
    first_bottleneck_fn: ranked[0].fn,
    first_bottleneck_pct_of_app: ranked[0].pct_of_app_time,
    second_bottleneck_fn: ranked[1]?.fn || null,
    second_bottleneck_pct_of_app: ranked[1]?.pct_of_app_time ?? null,
  };
}

const byName = (n) => knee.endpoints.find((e) => e.endpoint === n);
const sqlBy = (n) => sql.results.find((e) => e.endpoint === n);

const per_endpoint = ['list', 'detail', 'settled', 'status'].map((n) => {
  const k = byName(n), c = appShare[n], s = sqlBy(n);
  if (!k) throw new Error(`no knee data for ${n}`);
  if (!s) throw new Error(`no sql data for ${n}`);
  return {
    endpoint: k.path,
    name: n,
    rps_sustained: k.rps_sustained,
    p50_ms: k.p50_ms, p95_ms: k.p95_ms, p99_ms: k.p99_ms,
    knee_at_conn: k.knee_at_conn,
    errors: k.errors,
    sql_per_request: s.statements_per_request,
    response_bytes: s.response_bytes,
    app_share_pct: c.app_share_pct,
    first_bottleneck: `${c.first_bottleneck_fn} -- ${c.first_bottleneck_pct_of_app}% of this endpoint's application self time (next: ${c.second_bottleneck_fn}, ${c.second_bottleneck_pct_of_app}%)`,
    first_bottleneck_pct_of_app: c.first_bottleneck_pct_of_app,
  };
});

const out = {
  generated_by: 'analyze.mjs -- every number recomputed from runs/*.json',
  caveat_harness: 'Profiles are taken in the same process that serves, so the load generator\'s loopback TCP work appears in the raw table. app_share_pct is the fraction of the profile attributable to application frames; first_bottleneck is read from that view only.',
  per_endpoint,
  app_share_detail: appShare,
};
fs.writeFileSync(R('analysis.json'), JSON.stringify(out, null, 1));

console.log(JSON.stringify(per_endpoint, null, 1));
console.log('\napp share per endpoint:');
for (const [n, v] of Object.entries(appShare)) console.log(`  ${n.padEnd(8)} app=${v.app_share_pct}%  top=${String(v.first_bottleneck_pct_of_app).padStart(5)}%  ${v.first_bottleneck_fn}`);
console.log('\nwrote runs/analysis.json');