#!/usr/bin/env node
// Per-endpoint CPU sampling profiles, taken IN-PROCESS with node:inspector.
//
// WHY THIS SCRIPT STARTS THE SERVER ITSELF
// A profile of a separate client process measures the client, not the API. An
// earlier version of this file drove the server over HTTP and profiled itself;
// that is a measurement of the load generator and is worthless as evidence
// about the server. So here we `await import()` the API's own entrypoint and
// profile the very process that serves the requests. (node --cpu-prof is not an
// option on this stack: tsx re-execs node, the flag lands on the wrapper, and
// the profile comes out empty -- verified, not assumed.)
//
// Run:  node prof-per-endpoint.mjs      (with tsx loader + node_modules in NODE_PATH)
// LOCALHOST ONLY -- guarded before anything is imported.
import fs from 'node:fs';
import inspector from 'node:inspector';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 3401);
const ALLOWED = new Set(['127.0.0.1', 'localhost', '::1']);
if (!ALLOWED.has(HOST)) throw new Error(`REFUSING TO RUN: ${HOST} is not loopback (local-only task rule)`);

const ROOT = process.env.REPO_ROOT;
const API_DIR = path.join(ROOT, 'packages', 'api');
// All artefacts land next to THIS script, never relative to cwd -- a reviewer
// running from packages/api would otherwise scatter output into the checkout.
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, '$1'));
const OUTDIR = path.join(HERE, 'runs');
fs.mkdirSync(OUTDIR, { recursive: true });
const P = (f) => path.join(HERE, f);
if (!ROOT || !fs.existsSync(path.join(API_DIR, 'src', 'node.ts'))) {
  console.error('FATAL: set REPO_ROOT to the basedagents checkout root (contains packages/api/src/node.ts)');
  process.exit(97);
}
process.env.DATABASE_PATH = process.env.DATABASE_PATH || './data/registry.db';
process.env.PORT = String(PORT);

// Start the API in THIS process.
await import(pathToFileURL(path.join(API_DIR, 'src', 'node.ts')).href);
const base = `${HOST}:${PORT}`;

function req(p, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: HOST, port: PORT, path: p, headers, agent: new http.Agent({ keepAlive: true, maxSockets: 512 }) },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    r.on('error', reject); r.end();
  });
}

// Wait for the listener.
for (let i = 0; i < 100; i++) { try { if ((await req('/v1/status')) === 200) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }

// Real ids from the seeded local DB.
const listJson = JSON.parse(await new Promise((res) => http.get(`http://${base}/v1/tasks?status=all&limit=100`, (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => res(b)); })));
const tasks = listJson.tasks || [];
fs.writeFileSync(P('ids.json'), JSON.stringify(tasks.map((t) => ({ task_id: t.task_id, status: t.status })), null, 1));
const detailId = tasks.find((t) => t.status === 'open')?.task_id || tasks[0]?.task_id;

const TARGETS = [
  { endpoint: 'list',    path: '/v1/tasks?status=open&limit=50', n: 300, rotateIP: false },
  { endpoint: 'detail',  path: `/v1/tasks/${detailId}`,         n: 600, rotateIP: false },
  { endpoint: 'settled', path: '/v1/tasks/settled?limit=50',     n: 600, rotateIP: true },
  { endpoint: 'status',  path: '/v1/status',                     n: 600, rotateIP: false },
];

// settled is limited to 120 req/min per IP (x10 when E2E=1). Without rotation
// the limiter, not the endpoint, is what gets profiled: a first run recorded
// 540 of 600 requests as 429 and the "profile" was mostly rate-limit
// bookkeeping. We rotate X-Forwarded-For per request -- which is what many
// distinct clients look like -- and we still RECORD the 429 counts, so the
// limiter's cost is reported rather than hidden.
const ipFor = (i) => ({ 'x-forwarded-for': `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}` });

// Warmup OUTSIDE the profile so JIT lands before we sample.
for (const t of TARGETS) for (let i = 0; i < 60; i++) await req(t.path);

// The dev request logger (app.use('*', logger()), src/index.ts:142) is
// unconditional and costs more CPU than most application code -- in a first
// profile it was the #1 frame (`connect` 19%, plus writev/consoleCall). It is
// instrumentation, not the server's real work, so we silence stdout for the
// duration of the sampling and say so in the delivery. Silencing is not
// filtering: we do not drop frames, we stop generating logger frames at all.
const realLog = console.log;
const realWrite = process.stdout.write.bind(process.stdout);
console.log = () => {};
process.stdout.write = () => true;

const session = new inspector.Session();
session.connect();
const post = (m, p) => new Promise((res, rej) => session.post(m, p, (e, r) => (e ? rej(e) : res(r))));
await post('Profiler.enable');
await post('Profiler.setSamplingInterval', { interval: 100 });

const out = [];
for (const t of TARGETS) {
  await post('Profiler.start');
  const codes = {};
  for (let i = 0; i < t.n; i++) { const c = await req(t.path, t.rotateIP ? ipFor(i) : {}); codes[c] = (codes[c] || 0) + 1; }
  const { profile } = await post('Profiler.stop');

  // A profile dominated by non-200s is not a profile of the endpoint. Fail
  // loudly rather than publishing rate-limit bookkeeping as a CPU breakdown.
  const nonOk = Object.entries(codes).filter(([k]) => k !== '200').reduce((a, [, v]) => a + v, 0);
  if (nonOk > t.n * 0.02) {
    throw new Error(`${t.endpoint}: ${nonOk}/${t.n} non-200 responses -- profile would measure the limiter, not the endpoint. Raise IP rotation or lower n.`);
  }

  // Aggregate SELF time keyed by function AND file. Name-only keying collapses
  // same-named functions across files and last-write-wins -- that produced a
  // wrong headline number once already.
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const dt = profile.timeDeltas || [];
  for (let i = 0; i < profile.samples.length; i++) {
    const node = byId.get(profile.samples[i]); if (!node) continue;
    const cf = node.callFrame;
    const url = String(cf.url || '').replace(/^file:\/\/\/?.*?[\\/]/, '');
    const key = `${cf.functionName || '(anonymous)'} @ ${url}:${cf.lineNumber + 1}`;
    self.set(key, (self.get(key) || 0) + (dt[i] || 0));
  }
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  if (total <= 0) throw new Error(`EMPTY PROFILE for ${t.endpoint} -- refusing to report zeros as if they were data`);
  const table = [...self.entries()]
    .map(([fn, us]) => ({ fn, self_pct: +((us / total) * 100).toFixed(2), self_ms: +(us / 1000).toFixed(1) }))
    .sort((a, b) => b.self_pct - a.self_pct);

  const rec = {
    endpoint: t.endpoint, path: t.path, requests_profiled: t.n, http_codes: codes,
    sampling_interval_us: 100, total_self_ms: +(total / 1000).toFixed(1),
    frames_captured: self.size,
    top_self_time: table.slice(0, 15),
    complete_self_time_table: table,
  };
  out.push(rec);
  console.log = realLog;
  process.stdout.write = realWrite;
  console.log(`\n### ${t.endpoint}  ${t.path}  (${t.n} reqs, codes=${JSON.stringify(codes)}, ${rec.total_self_ms} ms self, ${self.size} frames)`);
  for (const r of table.slice(0, 10)) console.log(`  ${String(r.self_pct).padStart(6)}%  ${r.fn.slice(0, 96)}`);
  fs.writeFileSync(`${OUTDIR}/prof-${t.endpoint}.cpuprofile`, JSON.stringify(profile));
  // Re-silence for the next endpoint.
  console.log = () => {};
  process.stdout.write = () => true;
}

console.log = realLog;
process.stdout.write = realWrite;

fs.mkdirSync('runs', { recursive: true });
fs.writeFileSync(`${OUTDIR}/cpu-per-endpoint.json`, JSON.stringify({
  method: 'node:inspector Profiler attached to the SAME process that runs the API (src/node.ts imported in-process); 100us sampling; self time aggregated by function+file',
  server_in_process: true, base, endpoints: out,
}, null, 1));
console.log('\nwrote runs/cpu-per-endpoint.json');
session.disconnect();
process.exit(0);