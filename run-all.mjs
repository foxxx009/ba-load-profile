#!/usr/bin/env node
// One command that reproduces every run in this delivery, in order.
// LOCALHOST ONLY. Each step is independent and writes its own artefact;
// `node run-all.mjs` is the single entry point a reviewer can run.
//
// Prereqs (Linux or macOS):
//   git clone <public repo> basedagents && cd basedagents && npm install
//   # this delivery was produced on Windows; see README.md for the exact
//   # tsx loader invocation used there.
export const STEPS = [
  { file: 'ids.mjs',              produces: 'ids.json',              what: 'pull real task ids from the seeded local DB' },
  { file: 'seed-local-agent.mjs', produces: '(agents row)',           what: 'register the real Ed25519 test agent locally so signed writes pass auth' },
  { file: 'knee.mjs',             produces: 'runs/knee.{txt,json}',   what: 'staged-arrival knee sweep over list/detail/settled/status' },
  { file: 'count-sql.mjs',        produces: 'runs/count-sql.json',    what: 'statements prepared per request, via the sqltrace preload' },
  { file: 'row-scaling.mjs',      produces: 'runs/row-scaling.txt',   what: 'per-row cost of the list query' },
  { file: 'write-scenario.mjs',   produces: 'runs/write-scenario.{txt,json}', what: 'signed mixed write path at rising concurrency' },
  { file: 'prof-per-endpoint.mjs',produ: 'runs/cpu-per-endpoint.json', what: 'per-endpoint CPU profile of the handler (no socket in path)' },
  { file: 'analyze.mjs',          produces: 'runs/analysis.json',     what: 'recompute every quoted number; derive per-endpoint first bottleneck' },
  { file: 'audit.mjs',            produces: '(exit code)',            what: 'assert the delivery matches the artefacts on disk' },
];