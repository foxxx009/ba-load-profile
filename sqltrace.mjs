// Preload module: patch better-sqlite3's prepare() so every SQL statement the
// real server prepares is appended to a JSONL log. Nothing about the routes is
// reimplemented or guessed -- we count what the live process actually does.
//
// Loaded via NODE_OPTIONS="--import file:///<abs path>/sqltrace.mjs" alongside
// the tsx loader, so it installs before packages/api/src/node.ts is imported.
import fs from 'node:fs';
import { createRequire } from 'node:module';

const OUT = process.env.SQLTRACE_OUT || './runs/sqltrace.jsonl';
const require = createRequire(import.meta.url);

// Resolve better-sqlite3 out of the repo-root node_modules (hoisted).
let Database;
try {
  Database = require(process.env.BS3_PATH || 'better-sqlite3');
} catch (e) {
  // If we cannot patch, we must NOT silently report zero statements -- that is
  // exactly the "unreadable looks like absent" failure. Fail the boot loudly.
  console.error('[sqltrace] FATAL: cannot load better-sqlite3:', e.message);
  process.exit(97);
}

const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const origPrepare = Database.prototype.prepare;
let n = 0;
const fd = fs.openSync(OUT, 'a');

Database.prototype.prepare = function patched(sql) {
  const stmt = origPrepare.call(this, sql);
  const rec = { n: ++n, sql: norm(sql).slice(0, 400) };
  // Never let telemetry break the server, but never swallow the failure
  // silently either -- a silently-failing tracer would report zero statements,
  // which reads exactly like "this endpoint does no SQL". Loud, not silent.
  try {
    fs.writeSync(fd, JSON.stringify(rec) + '\n');
  } catch (e) {
    process.stderr.write(`[sqltrace] WRITE FAILED (n=${n}): ${e.message}\n`);
  }
  // Also expose a live total so the server can be sanity-checked from outside.
  globalThis.__sqltraceCount = n;
  return stmt;
};

process.on('exit', () => { try { fs.closeSync(fd); } catch {} });
console.error(`[sqltrace] patched better-sqlite3.prepare -> ${OUT}`);