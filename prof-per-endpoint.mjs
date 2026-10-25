#!/usr/bin/env node
// Per-endpoint CPU sampling profiles of the APPLICATION HANDLER, with the
// load generator's own cost removed.
//
// METHOD (and why it changed twice)
// v1 drove the server over HTTP from a separate process and profiled that
//    process -- a measurement of the client. Worthless.
// v2 started the server in-process but still called it over loopback HTTP, so
//    TCP connect/accept and the hono request logger dominated: application
//    frames were only 10-21% of each profile. Real, but diluted. Kept as
//    prof-http-v2.mjs and its output as runs/http-profile.json.
// v3 (this file) calls the exported Hono handler directly --
//    `mod.default.fetch(new Request(url), env)` -- with no socket, no server
//    and no logger middleware in the path. What is left in the samples is the
//    handler, the adapter and better-sqlite3: exactly the code the task asks us
//    to attribute. Each endpoint still gets its OWN profile and each
//    first_bottleneck is read off that endpoint's own complete top-N table.
//
// Run from packages/api:
//   REPO_ROOT=<checkout> DATABASE_PATH=./data/registry.db \
//   node --import file:///<checkout>/node_modules/tsx/dist/loader.mjs prof-per-endpoint.mjs
import fs from 'node:fs';
import path from 'node:path';
import inspector from 'node:inspector';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'runs');
fs.mkdirSync(OUT, { recursive: true });

const ROOT = process.env.REPO_ROOT;
if (!ROOT) { console.error('FATAL: set REPO_ROOT to the basedagents checkout root'); process.exit(97); }
const DB = process.env.DATABASE_PATH || './data/registry.db';
process.env.DATABASE_PATH = DB;

const { default: mod, setNodeAdapter } = await import(pathToFileURL(path.join(ROOT, 'packages', 'api', 'src', 'index.ts')).href);
const { default: Database } = await import(pathToFileURL(path.join(ROOT, 'node_modules', 'better-sqlite3', 'lib', 'index.js')).href);
const { SQLiteAdapter } = await import(pathToFileURL(path.join(ROOT, 'packages', 'api', 'src', 'db', 'sqlite-adapter.ts')).href);
// `mod` IS the default export object ({ fetch, scheduled }) -- mod.default is
// undefined. Verified against the module's real keys before using it.
const app = mod;
if (typeof app?.fetch !== 'function') { console.error('FATAL: exported default has no fetch(); keys=', Object.keys(mod)); process.exit(97); }
if (typeof setNodeAdapter !== 'function') { console.error('FATAL: setNodeAdapter is not exported'); process.exit(97); }
const sqliteDb = new Database(DB, { readonly: false });
sqliteDb.pragma('journal_mode = WAL');
setNodeAdapter(new SQLiteAdapter(sqliteDb));

const ORIGIN = 'http://127.0.0.1';
const call = (p, headers) => app.fetch(new Request(ORIGIN + p, headers ? { headers } : undefined), process.env);
// settled is limited to 120 req/min per IP. Calling the handler directly, every
// request has the same IP, so the limiter answers instead of the endpoint -- a
// run that ignored this profiled the limiter (800/800 were 429). Rotating
// X-Forwarded-For per request models many distinct clients; the 429 counts are
// still recorded so the limiter's own cost stays visible.
const ipFor = (i) => ({ 'x-forwarded-for': `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}` });

const listJson = await (await call('/v1/tasks?status=all&limit=100')).json();
const tasks = listJson.tasks || [];
fs.writeFileSync(path.join(HERE, 'ids.json'), JSON.stringify(tasks.map((t) => ({ task_id: t.task_id, status: t.status })), null, 1));
const detailId = tasks.find((t) => t.status === 'open')?.task_id || tasks[0]?.task_id;

const TARGETS = [
  { endpoint: 'list',    path: '/v1/tasks?status=open&limit=50', n: 400 },
  { endpoint: 'detail',  path: `/v1/tasks/${detailId}`,         n: 800 },
  { endpoint: 'settled', path: '/v1/tasks/settled?limit=50',     n: 800, rotateIP: true },
  { endpoint: 'status',  path: '/v1/status',                     n: 800 },
];

for (const t of TARGETS) for (let i = 0; i < 80; i++) await call(t.path, t.rotateIP ? ipFor(i) : undefined); // warm, unprofiled

const session = new inspector.Session();
session.connect();
const post = (m, p) => new Promise((res, rej) => session.post(m, p, (e, r) => (e ? rej(e) : res(r))));
await post('Profiler.enable');
await post('Profiler.setSamplingInterval', { interval: 100 });

const out = [];
for (const t of TARGETS) {
  await post('Profiler.start');
  const codes = {};
  for (let i = 0; i < t.n; i++) { const r = await call(t.path, t.rotateIP ? ipFor(i) : undefined); codes[r.status] = (codes[r.status] || 0) + 1; }
  const { profile } = await post('Profiler.stop');

  const nonOk = Object.entries(codes).filter(([k]) => k !== '200').reduce((a, [, v]) => a + v, 0);
  if (nonOk > t.n * 0.02) throw new Error(`${t.endpoint}: ${nonOk}/${t.n} non-200 -- this profile would not describe the happy path`);

  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const dt = profile.timeDeltas || [];
  for (let i = 0; i < profile.samples.length; i++) {
    const node = byId.get(profile.samples[i]); if (!node) continue;
    const cf = node.callFrame;
    const key = `${cf.functionName || '(anonymous)'} @ ${String(cf.url || '')}:${cf.lineNumber + 1}`;
    self.set(key, (self.get(key) || 0) + (dt[i] || 0));
  }
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  if (total <= 0) throw new Error(`${t.endpoint}: empty profile -- refusing to publish zeros`);
  const table = [...self.entries()]
    .map(([fn, us]) => ({ fn, self_pct: +((us / total) * 100).toFixed(2), self_ms: +(us / 1000).toFixed(1) }))
    .sort((a, b) => b.self_pct - a.self_pct);

  const rec = {
    endpoint: t.endpoint, path: t.path, requests_profiled: t.n, http_codes: codes,
    sampling_interval_us: 100, total_self_ms: +(total / 1000).toFixed(1), frames_captured: self.size,
    top_self_time: table.slice(0, 15), complete_self_time_table: table,
  };
  out.push(rec);
  fs.writeFileSync(path.join(OUT, `prof-${t.endpoint}.cpuprofile`), JSON.stringify(profile));
  console.log(`### ${t.endpoint}  ${t.path}  n=${t.n} codes=${JSON.stringify(codes)} self=${rec.total_self_ms}ms frames=${self.size}`);
  for (const r of table.slice(0, 9)) console.log(`  ${String(r.self_pct).padStart(6)}%  ${r.fn.replace(/.*?packages\/api\//, 'api/').replace(/.*?node_modules\//, 'nm/')}`);
}

fs.writeFileSync(path.join(OUT, 'cpu-per-endpoint.json'), JSON.stringify({
  method: 'node:inspector Profiler on the exported Hono handler (app.fetch) with the SQLiteAdapter the server uses; no socket, no server, no logger middleware in the sampled path; 100us sampling; self time keyed by function+file',
  version: 'v3-direct-handler',
  compared_with: 'runs/http-profile.json (v2, in-process over loopback HTTP); the delta is harness cost v3 removes',
  endpoints: out,
}, null, 1));
session.disconnect();
console.log('\nwrote runs/cpu-per-endpoint.json');