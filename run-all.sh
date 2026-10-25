#!/usr/bin/env bash
# Reproduce every number in this delivery from a clean clone.  LOCAL ONLY.
#
# Each step below is also listed, with its exact command, in the delivery's
# runs[] array.  Every scenario refuses to run against a non-loopback host.
#
#   Linux:   bash run-all.sh
#   macOS:   bash run-all.sh
#   Windows: run-all.sh works under Git Bash / WSL as well; the only
#            platform-specific bit is NODE, which can be overridden.
#
# Prerequisites:
#   git clone https://github.com/maxfain/basedagents basedagents-main
#   cd basedagents-main && npm install --workspace=packages/api
#   # migrations apply automatically the first time src/node.ts starts
set -euo pipefail
cd "$(dirname "$0")"

# ---------------------------------------------------------------------------
# Configuration. Every value can be overridden from the environment; nothing
# below depends on the machine that produced the delivery.
# ---------------------------------------------------------------------------
NODE="${NODE:-node}"                       # any Node >= 20
REPO_ROOT="${REPO_ROOT:-}"                 # checkout of maxfain/basedagents
BA_TARGET="${BA_TARGET:-http://127.0.0.1:3399}"
PORT="${PORT:-3399}"
export PORT BA_TARGET
export REPO_ROOT
# The API creates its SQLite file here on first start (packages/api/data).
export DATABASE_PATH="${DATABASE_PATH:-$REPO_ROOT/packages/api/data/registry.db}"
export KEYPAIR="${KEYPAIR:-$HOME/.basedagents/keys/fitze-x402-keypair.json}"

# ---------------------------------------------------------------------------
# Hard guard: this harness only ever measures a LOCAL instance.  Refuse to
# point a load generator at a deployed environment.
# ---------------------------------------------------------------------------
case "$BA_TARGET" in
  http://localhost:*|http://127.0.0.1:*) ;;
  *) echo "LOCALHOST GUARD: refusing '$BA_TARGET'" >&2; exit 1 ;;
esac
echo "[guard] local target only: $BA_TARGET"

if [ -z "$REPO_ROOT" ] || [ ! -d "$REPO_ROOT" ]; then
  echo "REPO_ROOT must point at a checkout of maxfain/basedagents" >&2
  echo "  git clone https://github.com/maxfain/basedagents \$REPO_ROOT" >&2
  exit 1
fi

# tsx must be loaded through a file:// URL; a bare absolute path fails with
# ERR_UNSUPPORTED_ESM_URL_SCHEME.  NODE_PATH must point at the repo-root
# node_modules, because the workspace package keeps none of its own.
export NODE_PATH="$REPO_ROOT/node_modules"
TSX_LOADER="$REPO_ROOT/node_modules/tsx/dist/loader.mjs"
if [ ! -f "$TSX_LOADER" ]; then
  echo "tsx loader not found at $TSX_LOADER -- run 'npm install' in $REPO_ROOT" >&2
  exit 1
fi

echo "[1] start local API (src/node.ts) and wait for /v1/status"
"$NODE" --import "file://$TSX_LOADER" "$REPO_ROOT/packages/api/src/node.ts" \
  > runs/server.log 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do
  if curl -fsS "$BA_TARGET/v1/status" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "$BA_TARGET/v1/status" >/dev/null || { echo "server did not come up" >&2; exit 1; }
echo "    server up (pid $SERVER_PID)"

echo "[2] ids: pull real task ids from the seeded local DB"
"$NODE" ids.mjs | tail -3

echo "[3] seed-local-agent: register the Ed25519 test agent locally"
"$NODE" seed-local-agent.mjs | tail -2

echo "[4] knee: staged-arrival sweep over list/detail/settled/status"
"$NODE" knee.mjs | tail -12

echo "[5] count-sql: statements prepared per request (needs the sqltrace preload)"
"$NODE" --import file://"$(pwd)/sqltrace.mjs" count-sql.mjs | tail -20

echo "[6] row-scaling: per-row cost of the list query"
"$NODE" row-scaling.mjs | tail -12

echo "[7] write-scenario: signed mixed write path at rising concurrency"
"$NODE" write-scenario.mjs | tail -12

echo "[8] prof-per-endpoint: per-endpoint CPU profile of the handler"
"$NODE" --import "file://$TSX_LOADER" prof-per-endpoint.mjs | tail -6

echo "[9] analyze: recompute every quoted number"
"$NODE" analyze.mjs | tail -10

echo "[10] audit: assert the delivery matches the artefacts on disk"
"$NODE" audit.mjs | tail -6

echo "[done] artefacts under runs/"
