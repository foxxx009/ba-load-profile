#!/usr/bin/env node
// Shared harness for every load scenario in this delivery.
// LOCALHOST ONLY -- the base URL is hard-guarded in every scenario file; the
// runner aborts rather than ever pointing a load test at a deployed host.
import http from 'node:http';

export const HOST = '127.0.0.1';
export const PORT = Number(process.env.PORT || 3399);

export function guardLocal() {
  const allow = new Set(['127.0.0.1', 'localhost', '::1']);
  if (!allow.has(HOST)) {
    throw new Error(`REFUSING TO RUN: target ${HOST} is not loopback (local-only task rule)`);
  }
  return `${HOST}:${PORT}`;
}

export function req(path, { headers = {}, method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(body);
    const r = http.request(
      {
        host: HOST, port: PORT, path, method,
        headers: {
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
          ...headers,
        },
        agent: new http.Agent({ keepAlive: true, maxSockets: 1024 }),
      },
      (res) => {
        let n = 0, chunks = [];
        res.on('data', (c) => { n += c.length; chunks.push(c); });
        res.on('end', () => resolve({ status: res.statusCode, bytes: n, body: Buffer.concat(chunks).toString() }));
      }
    );
    r.on('error', reject);
    r.end(payload);
  });
}

// Staged-arrival generator: `conn` concurrent workers, each issuing `perWorker`
// requests back to back. Workers never wait for a barrier -- that is the point:
// we want open-loop-ish saturation with a fixed concurrency, not coordinated batches.
export async function staged({ conn, perWorker, path, headersFn, onSample }) {
  const workers = [];
  const lat = [];
  let ok = 0, err = 0, bytes = 0;
  const statuses = {};
  for (let w = 0; w < conn; w++) {
    workers.push((async () => {
      for (let i = 0; i < perWorker; i++) {
        const t0 = performance.now();
        try {
          const r = await req(path, { headers: headersFn ? headersFn(w, i) : {} });
          const dt = performance.now() - t0;
          lat.push(dt);
          bytes += r.bytes;
          statuses[r.status] = (statuses[r.status] || 0) + 1;
          if (r.status >= 200 && r.status < 400) ok++; else err++;
          if (onSample) onSample(dt, r);
        } catch (e) {
          err++;
          statuses['EXC:' + e.code] = (statuses['EXC:' + e.code] || 0) + 1;
        }
      }
    })());
  }
  const t0 = performance.now();
  await Promise.all(workers);
  const wall = performance.now() - t0;
  return { conn, perWorker, path, wall_ms: +wall.toFixed(1), total: ok + err, ok, err, bytes,
           rps: +((ok + err) / (wall / 1000)).toFixed(2), pct: pct(lat), statuses };
}

export function pct(arr) {
  if (!arr.length) return { p50: null, p95: null, p99: null, max: null, mean: null };
  const a = [...arr].sort((x, y) => x - y);
  const q = (p) => +a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))].toFixed(2);
  return { p50: q(50), p95: q(95), p99: q(99), max: +a[a.length - 1].toFixed(2),
           mean: +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(2) };
}

export function table(rows) {
  const cols = ['conn', 'rps', 'p50', 'p95', 'p99', 'max', 'ok', 'err'];
  const head = cols.map((c) => c.padStart(10)).join('');
  const body = rows.map((r) => cols.map((c) => String(r[c] ?? r.pct?.[c] ?? '').padStart(10)).join(''));
  return [head, ...body].join('\n');
}