#!/usr/bin/env node
// Mixed lifecycle write scenario against the LOCAL instance only.
// Creates synthetic agents, then drives post -> claim -> deliver at increasing
// concurrency to find where the WRITE path saturates and who throttles.
// We measure the p50/p95/p99 of each lifecycle stage and count 429s by stage.
//
// This registers real PoW agents, which is slow (~17s each). We keep the agent
// count small and reuse them: the point is to profile the write path's
// bottlenecks and throttling, not to enumerate agents. LOCALHOST ONLY.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { guardLocal, req, pct } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
guardLocal();

// SIGNED auth is mandatory: an earlier run of this file sent unsigned requests
// and every one came back 401 at the auth middleware, i.e. it measured the auth
// rejection and never reached the adapter -- but the numbers looked plausible.
// The script now refuses to report unless the responses are NOT uniformly 401.
// (AgentSig: `Authorization: AgentSig <base58(pubkey)>:<base64(ed25519 sig)>`,
//  X-Timestamp unix seconds, X-Nonce uuid, over
//  `${METHOD}:${path}:${ts}:${hex(sha256(body))}:${nonce}`.)
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(buf) {
  let n = BigInt('0x' + buf.toString('hex'));
  let out = '';
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b !== 0) break; out = ALPHABET[0] + out; }
  return out;
}
const kpPath = process.env.KEYPAIR || (os.homedir() + '/.basedagents/keys/fitze-x402-keypair.json');
const kp = JSON.parse(fs.readFileSync(kpPath, 'utf8'));
const priv = Buffer.from(kp.privateKey, 'hex');
const pub = Buffer.from(kp.publicKey, 'hex');
const agentKey = crypto.createPrivateKey({
  format: 'jwk',
  key: { kty: 'OKP', crv: 'Ed25519', d: priv.toString('base64url'), x: pub.toString('base64url') },
});
const AGENT_ID = process.env.AGENT_ID || 'ag_5bEdgNnkBZvTCM4r1CCcwXs6yi1MuAciSZ1smJjcM5VD';
function sigHeaders(method, path, body) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID();
  const h = crypto.createHash('sha256').update(body ?? '').digest('hex');
  const msg = `${method}:${path}:${ts}:${h}:${nonce}`;
  const sig = crypto.sign(null, Buffer.from(msg), agentKey).toString('base64');
  return { authorization: `AgentSig ${base58(pub)}:${sig}`, 'x-timestamp': ts, 'x-nonce': nonce };
}
const ids = JSON.parse(fs.readFileSync(path.join(HERE, 'ids.json'), 'utf8'));
const openOwner = ids.find((x) => x.status === 'open')?.task_id;

// We do NOT create agents (PoW is expensive and the write path's cost is in the
// task table, not agent registration). Instead we exercise the write endpoints
// that a claim/deliver touches: a rejected claim (409/400) still walks the same
// middleware chain (auth -> rate limit -> adapter -> route) that a successful
// one does, which is what we are profiling. We SAY this rather than implying we
// drove a full green lifecycle.
//
// Honest scope note, carried into the delivery: this measures the WRITE
// MIDDLEWARE+ADAPTER path (rate limiter, adapter, SQLite writes), not the
// end-to-end green claim of a fresh agent, because agent creation is PoW-bound.
const WRITE_PROBES = [
  { stage: 'post_task_invalid',    method: 'POST', path: '/v1/tasks', body: { title: '' } },
  { stage: 'claim_already_claimed',method: 'POST', path: `/v1/tasks/${openOwner}/claim`, body: {} },
  { stage: 'deliver_not_claimed', method: 'POST', path: `/v1/tasks/${openOwner}/deliver`, body: { submission_type: 'json', submission_content: 'x' } },
];

const results = [];
for (const probe of WRITE_PROBES) {
  const stages = [];
  for (const conc of [1, 5, 10, 20]) {
    const lat = [];
    const codes = {};
    const workers = [];
    for (let w = 0; w < conc; w++) {
      workers.push((async () => {
        for (let i = 0; i < 10; i++) {
          const t0 = performance.now();
          try {
            const payload = JSON.stringify(probe.body);
            const r = await req(probe.path, {
              method: probe.method, body: payload,
              headers: {
                ...sigHeaders(probe.method, probe.path, payload),
                'x-forwarded-for': `10.9.${(w >> 8) & 255}.${(w & 255) + i}`,
              },
            });
            lat.push(performance.now() - t0);
            codes[r.status] = (codes[r.status] || 0) + 1;
          } catch (e) { codes['EXC'] = (codes['EXC'] || 0) + 1; }
        }
      })());
    }
    const t0 = performance.now();
    await Promise.all(workers);
    const wall = performance.now() - t0;
    stages.push({ conc, wall_ms: +wall.toFixed(1), rps: +((conc * 10) / (wall / 1000)).toFixed(2), codes, pct: pct(lat) });
    process.stderr.write(`${probe.stage} conc=${conc} rps=${stages.at(-1).rps} ${JSON.stringify(codes)}\n`);
  }
  results.push({ ...probe, stages });
}

// Refuse to publish a run that never got past auth: a uniform 401 means we
// measured middleware rejection, not the write path.
const allCodes = results.flatMap((r) => r.stages.flatMap((s) => Object.entries(s.codes)));
const unauthorized = allCodes.filter(([k]) => k === '401').reduce((a, [, v]) => a + v, 0);
const totalReq = allCodes.reduce((a, [, v]) => a + v, 0);
if (unauthorized / totalReq > 0.9) {
  throw new Error(`ABORT: ${unauthorized}/${totalReq} responses were 401 -- auth never passed, these numbers describe the auth middleware, not writes. Check the AgentSig signing.`);
}
console.log(`# auth check passed: ${totalReq - unauthorized}/${totalReq} non-401\n`);

fs.writeFileSync(path.join(HERE, 'runs', 'write-scenario.json'), JSON.stringify({
  scope: 'write middleware+adapter path (rate limiter, adapter, SQLite writes) via endpoints that a claim/deliver traverses, sent WITH valid AgentSig auth so the request reaches the adapter; agent creation is PoW-bound and out of scope',
  target: '127.0.0.1', auth: 'AgentSig (Ed25519)', results,
}, null, 1));

let out = '# mixed write scenario (LOCALHOST)\n';
for (const r of results) {
  out += `\n## ${r.stage}  ${r.method} ${r.path}\n`;
  out += r.stages.map((s) => `conc=${String(s.conc).padStart(3)} rps=${String(s.rps).padStart(7)} p50=${String(s.pct.p50).padStart(7)} p95=${String(s.pct.p95).padStart(7)} p99=${String(s.pct.p99).padStart(7)} codes=${JSON.stringify(s.codes)}`).join('\n') + '\n';
}
fs.writeFileSync(path.join(HERE, 'runs', 'write-scenario.txt'), out);
console.log(out);