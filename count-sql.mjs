#!/usr/bin/env node
// Per-endpoint SQL statement count, measured against the LIVE server.
//
// The server is booted with sqltrace.mjs preloaded (it patches
// better-sqlite3.prepare and appends every statement to runs/sqltrace.jsonl).
// We read the log's length before and after ONE request, so the delta is
// exactly the statements that request prepared -- migrations and startup are
// already flushed out by the warmup.
//
// This is a measurement, not an inference from reading the route source.
// LOCALHOST ONLY.
import fs from 'node:fs';
import { guardLocal, req } from './lib.mjs';

guardLocal();
const LOG = './runs/sqltrace.jsonl';
const ids = JSON.parse(fs.readFileSync('./ids.json', 'utf8'));
const detailId = ids.find((x) => x.status === 'open')?.task_id || ids[0].task_id;

function readLog() {
  if (!fs.existsSync(LOG)) return [];
  return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// Warmup: touch every endpoint once so lazily-prepared statements and first-hit
// JIT are already paid for before we measure.
for (const p of ['/v1/tasks?status=open&limit=50', `/v1/tasks/${detailId}`, '/v1/tasks/settled?limit=50', '/v1/status']) {
  await req(p);
}
await new Promise((r) => setTimeout(r, 300));

const TARGETS = [
  { endpoint: 'list',    path: '/v1/tasks?status=open&limit=50' },
  { endpoint: 'detail',  path: `/v1/tasks/${detailId}` },
  { endpoint: 'settled', path: '/v1/tasks/settled?limit=50' },
  { endpoint: 'status',  path: '/v1/status' },
];

const results = [];
for (const t of TARGETS) {
  const before = readLog().length;
  const r = await req(t.path);
  await new Promise((res) => setTimeout(res, 120));
  const after = readLog().length;
  const stmts = readLog().slice(before).map((x) => x.sql);
  results.push({
    endpoint: t.endpoint, path: t.path, http_status: r.status,
    response_bytes: r.bytes, statements_per_request: stmts.length,
    uses_all: stmts.length > 0, statements: stmts,
  });
  console.log(`${t.endpoint.padEnd(8)} http=${r.status} bytes=${String(r.bytes).padStart(6)} SQL=${stmts.length}`);
  for (const s of stmts) console.log(`    ${s.slice(0, 150)}`);
}

fs.writeFileSync('./runs/count-sql.json', JSON.stringify({
  method: 'better-sqlite3.prepare patched via sqltrace.mjs preload; delta of the JSONL log across ONE request after warmup',
  target: '127.0.0.1', results,
}, null, 1));
console.log('\nwrote runs/count-sql.json');