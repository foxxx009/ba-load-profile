# ba-load-profile

Load-profile harness for a **local** instance of the BasedAgents API
(`maxfain/basedagents`, `packages/api/src/node.ts`).

Everything here measures a **loopback** instance only. Every scenario calls
`guardLocal()` and refuses to run against a non-loopback host.

## What is measured

| endpoint | why it is interesting |
|---|---|
| `GET /v1/tasks?status=open&limit=50` | list -- per-row shaping + JSON serialization |
| `GET /v1/tasks/:id` | detail -- 4 sequential single-row statements |
| `GET /v1/tasks/settled?limit=50` | settled -- rate limiter writes on a read path |
| `GET /v1/status` | status -- 7 aggregate statements for a small payload |

## Reproduce

```bash
git clone https://github.com/maxfain/basedagents basedagents-main
cd basedagents-main && npm install --workspace=packages/api

cd ../ba-load-profile
export REPO_ROOT="$PWD/../basedagents-main"
export KEYPAIR="$HOME/.basedagents/keys/fitze-x402-keypair.json"
bash run-all.sh
```

`run-all.sh` starts the local API, waits for `/v1/status`, then runs every
scenario in order and finishes with `audit.mjs`, which asserts that the
delivery's quoted numbers match the artefacts on disk.

Each step is also listed with its exact command in the delivery's `runs[]`
array.

## Notes for reviewers

- `run-all.sh` is POSIX bash; it runs on Linux and macOS. `NODE`, `REPO_ROOT`,
  `PORT`, `DATABASE_PATH` and `KEYPAIR` are all environment-overridable; no
  path in this repository is hardcoded to one machine.
- `tsx` must be loaded through a `file://` URL (`--import file://$REPO_ROOT/node_modules/tsx/dist/loader.mjs`);
  a bare absolute path fails with `ERR_UNSUPPORTED_ESM_URL_SCHEME`.
- `NODE_PATH` must point at the **repo-root** `node_modules` -- the
  `packages/api` workspace keeps none of its own.
- `audit.mjs` recomputes every number quoted in the delivery from
  `runs/*.json` and fails if any of them disagrees. It is the check, not a
  transcript.
