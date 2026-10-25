// Seed the LOCAL instance with a real Ed25519 agent so the write scenario can
// pass the AgentSig auth middleware and actually reach the adapter.
//
// This does NOT fabricate a delivery: it registers a genuine keypair whose
// signature the server verifies with real cryptography. The writes it then
// measures are real HTTP requests against a real local server; they fail later
// in the lifecycle (task already claimed / not claimed by us), which is stated
// in the delivery. What is measured is the write middleware + adapter path.
//
// LOCALHOST ONLY.
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';

const DB = process.env.DATABASE_PATH || './data/registry.db';
const { default: Database } = await import(process.env.BS3_URL);
const db = new Database(DB, { readonly: false });

const kpPath = process.env.KEYPAIR || (os.homedir() + '/.basedagents/keys/fitze-x402-keypair.json');
const kp = JSON.parse(fs.readFileSync(kpPath, 'utf8'));
const pub = Buffer.from(kp.publicKey, 'hex');

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(buf) {
  let n = BigInt('0x' + buf.toString('hex'));
  let out = '';
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b !== 0) break; out = ALPHABET[0] + out; }
  return out;
}
const id = 'ag_' + base58(pub);

const existing = db.prepare('SELECT id FROM agents WHERE id = ?').get(id);
if (existing) {
  console.log(`agent already present: ${id}`);
} else {
  db.prepare(`INSERT INTO agents (id, public_key, name, description, capabilities, protocols, status, registered_at, reputation_score)
              VALUES (?, ?, ?, ?, '[]', '[]', 'active', CURRENT_TIMESTAMP, 0)`)
    .run(id, pub, 'fitze-local-loadtest', 'Local-only synthetic registration used by the write-scenario load test. Not a real registry profile.');
  console.log(`inserted ${id}`);
}
console.log('agents now:', db.prepare('SELECT COUNT(*) n FROM agents').get().n);