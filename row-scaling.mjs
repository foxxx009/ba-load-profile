#!/usr/bin/env node
// Per-row cost of the board list query.
//
// The list endpoint returns N rows and its cost should be linear in N if the
// bottleneck is per-row shaping/serialization rather than a fixed query cost.
// We sweep limit = 1,5,10,25,50,100 and fit a line through (rows, bytes) and
// (rows, server_ms); the intercept is the fixed cost and the slope is the
// per-row cost. A statement count of exactly 1 at every limit is what rules out
// an N+1 in the query itself.
// LOCALHOST ONLY.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardLocal, req } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
guardLocal();

// Which status to sweep. The board must actually HAVE enough rows in that
// status, otherwise every limit returns the same row count and the "scaling"
// curve is flat -- which looks like a valid measurement and is not. A first
// run swept status=open against a local DB holding only 5 open tasks: limits
// 5..100 all returned 5 rows and the least-squares fit was meaningless.
// We now measure the largest status present and assert the row count actually
// varies with the limit.
const whichStatus = process.env.SWEEP_STATUS || null;
let status = whichStatus;
if (!status) {
  const probe = JSON.parse((await req('/v1/tasks?status=all&limit=100')).body);
  void probe;
  const st = await req('/v1/status');
  const stats = JSON.parse(st.body).stats || {};
  void stats;
  // Pick the status with the most tasks by reading it from the API.
  let best = { name: 'all', n: -1 };
  for (const s of ['open', 'claimed', 'submitted', 'verified', 'closed', 'all']) {
    const r = await req(`/v1/tasks?status=${s}&limit=100`);
    let n = 0;
    try { n = (JSON.parse(r.body).tasks || []).length; } catch { n = 0; }
    if (n > best.n) best = { name: s, n };
  }
  status = best.name;
}
console.log(`sweeping status=${status}`);

const LIMITS = [1, 5, 10, 25, 50, 100];
const REPS = 60;
const rows = [];

for (const limit of LIMITS) {
  const p = `/v1/tasks?status=${status}&limit=${limit}`;
  for (let i = 0; i < 20; i++) await req(p); // warm

  const lat = [];
  let bytes = 0, nrows = 0;
  for (let i = 0; i < REPS; i++) {
    const t0 = performance.now();
    const r = await req(p);
    lat.push(performance.now() - t0);
    bytes = r.bytes;
    if (i === 0) nrows = (JSON.parse(r.body).tasks || []).length;
  }
  lat.sort((a, b) => a - b);
  const p50 = lat[Math.floor(lat.length * 0.5)];
  rows.push({ limit, rows_returned: nrows, bytes, p50_ms: +p50.toFixed(3) });
  console.log(`limit=${String(limit).padStart(3)} rows=${String(nrows).padStart(3)} bytes=${String(bytes).padStart(6)} p50=${p50.toFixed(3)}ms`);
}

// Guard: a real scaling curve needs the row count to actually move.
const distinct = new Set(rows.map((r) => r.rows_returned));
if (distinct.size < 3) {
  throw new Error(`ABORT: row count never varied (${[...distinct].join(',')}) -- the status has too few rows to measure per-row cost. Point SWEEP_STATUS at a status with more rows.`);
}

// Least-squares fit of p50_ms and bytes against rows.
function fit(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const slope = num / den;
  return { intercept: +(my - slope * mx).toFixed(4), slope: +slope.toFixed(5) };
}
const xs = rows.map((r) => r.rows_returned);
const timeFit = fit(xs, rows.map((r) => r.p50_ms));
const byteFit = fit(xs, rows.map((r) => r.bytes));

const out = `# per-row scaling of GET /v1/tasks?status=${status}&limit=N  (LOCALHOST, ${REPS} reps, 20 warmup each)\n` +
  rows.map((r) => `limit=${String(r.limit).padStart(3)} rows=${String(r.rows_returned).padStart(3)} bytes=${String(r.bytes).padStart(6)} p50_ms=${r.p50_ms}`).join('\n') +
  `\n\nleast squares vs rows_returned:\n  p50_ms  = ${timeFit.intercept} + ${timeFit.slope} * rows\n  bytes   = ${byteFit.intercept} + ${byteFit.slope} * rows\n` +
  `interpretation: the intercept is the fixed per-request cost (query + routing);\n` +
  `the slope is the per-row cost (row shaping in publicTaskShape + JSON serialization).\n` +
  `statements per request are exactly 1 at every limit (see runs/count-sql.json),\n` +
  `so this slope is NOT an N+1 in SQL -- it is per-row work after one query.\n`;
fs.writeFileSync(path.join(HERE, 'runs', 'row-scaling.txt'), out);
fs.writeFileSync(path.join(HERE, 'runs', 'row-scaling.json'), JSON.stringify({ rows, timeFit, byteFit }, null, 1));
console.log('\n' + out);