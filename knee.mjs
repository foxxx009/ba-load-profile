#!/usr/bin/env node
// Sweep all four hot reads the task names: board list, task detail, settled, status.
// Staged arrival at each concurrency level; report the knee per endpoint.
// LOCALHOST ONLY -- guardLocal() aborts on any non-loopback host.
import fs from 'node:fs';
import { guardLocal, staged, table } from './lib.mjs';

const base = guardLocal();
const ids = JSON.parse(fs.readFileSync('./ids.json', 'utf8'));
const detailId = ids.find((x) => x.status === 'open')?.task_id || ids[0].task_id;

const ENDPOINTS = [
  { name: 'list',    path: '/v1/tasks?status=open&limit=50' },
  { name: 'detail',  path: `/v1/tasks/${detailId}` },
  { name: 'settled', path: '/v1/tasks/settled?limit=50' },
  { name: 'status',  path: '/v1/status' },
];

// settled is rate-limited 120 req/min per IP (x10 with E2E=1). Rotating
// X-Forwarded-For is how a real multi-client caller looks; we rotate so the
// knee measures the endpoint rather than the limiter.
const rotIP = (w) => ({ 'x-forwarded-for': `10.${(w >> 16) & 255}.${(w >> 8) & 255}.${w & 255}` });

const CONNS = [1, 5, 10, 20, 40, 80, 160];
const PER_WORKER = 20;

const all = [];
for (const ep of ENDPOINTS) {
  const rows = [];
  for (const conn of CONNS) {
    const r = await staged({
      conn, perWorker: PER_WORKER, path: ep.path,
      headersFn: ep.name === 'settled' ? (w) => rotIP(w + conn * 1000) : undefined,
    });
    rows.push(r);
    process.stderr.write(`${ep.name} conn=${conn} rps=${r.rps} p50=${r.pct.p50} err=${r.err} ${JSON.stringify(r.statuses)}\n`);
  }
  // Knee = smallest conn whose rps is >= 90% of the best rps seen.
  const best = Math.max(...rows.map((r) => r.rps));
  const knee = rows.find((r) => r.rps >= best * 0.9);
  const atKnee = knee || rows[rows.length - 1];
  all.push({
    endpoint: ep.name, path: ep.path, target: base,
    conns: rows, knee_at_conn: atKnee.conn, rps_sustained: atKnee.rps,
    p50_ms: atKnee.pct.p50, p95_ms: atKnee.pct.p95, p99_ms: atKnee.pct.p99,
    errors: atKnee.err, knee_rule: 'smallest conn with rps >= 90% of peak',
    peak_rps: best,
  });
}

const lines = [];
lines.push(`# knee sweep  target=${base}  perWorker=${PER_WORKER}  conns=${CONNS.join(',')}`);
lines.push(`# knee = smallest conn whose rps >= 90% of that endpoint's peak rps`);
for (const e of all) {
  lines.push('');
  lines.push(`## ${e.endpoint}  ${e.path}`);
  lines.push(table(e.conns.map((r) => ({ ...r, ...r.pct }))));
  lines.push(`knee_at_conn=${e.knee_at_conn} rps_sustained=${e.rps_sustained} peak=${e.peak_rps} errors=${e.errors}`);
}
const out = lines.join('\n');
fs.writeFileSync('./runs/knee.txt', out);
fs.writeFileSync('./runs/knee.json', JSON.stringify({ target: base, perWorker: PER_WORKER, conns: CONNS, endpoints: all }, null, 1));
console.log(out);