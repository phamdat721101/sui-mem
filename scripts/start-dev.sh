#!/usr/bin/env bash
# start-dev.sh — full-stack dev runner for OpenX.
#
# What it does:
#   1. Loads .env + .env.local so the api sees its config.
#   2. Builds the SDK (api + frontend depend on its dist).
#   3. Starts the api on :3001.
#   4. Waits for /health, then starts the frontend on :3000.
#   5. Prints a banner with the URLs developers need.
#   6. Tears both processes down cleanly on Ctrl+C.
#
# Flags:
#   --no-frontend   start api only
#   --no-build      skip the SDK build (faster restart while iterating)
set -euo pipefail
cd "$(dirname "$0")/.."

WANT_FRONTEND=1
WANT_BUILD=1
for arg in "$@"; do
  case "$arg" in
    --no-frontend) WANT_FRONTEND=0 ;;
    --no-build)    WANT_BUILD=0 ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
  esac
done

# Load env files (both — .env.local wins for any duplicate key)
set -a
[ -f .env ] && source .env
[ -f .env.local ] && source .env.local
set +a

# ─── Pre-flight ────────────────────────────────────────────────────────────
echo "==> Pre-flight checks"
if [ -z "${DATABASE_URL:-}" ]; then
  echo "    [warn] DATABASE_URL not set — v2/v3 routes (brains, agents, earnings) will 500."
else
  echo "    [ok]   DATABASE_URL set"
fi

# ─── Build ─────────────────────────────────────────────────────────────────
if [ "$WANT_BUILD" -eq 1 ]; then
  echo ""
  echo "==> Building SDK (api + frontend depend on its dist)"
  npm run sdk:build --silent
fi

# ─── Start api ─────────────────────────────────────────────────────────────
echo ""
echo "==> Starting API (port 3001)"
npm run api:dev &
API_PID=$!

# Wait for api health (max 30s).
for i in $(seq 1 30); do
  if curl -sf http://localhost:3001/health >/dev/null 2>&1; then break; fi
  if ! kill -0 "$API_PID" 2>/dev/null; then
    echo "    [error] api process died during boot. Check the logs above."
    exit 1
  fi
  sleep 1
done

# ─── Start frontend ────────────────────────────────────────────────────────
FRONTEND_PID=""
if [ "$WANT_FRONTEND" -eq 1 ]; then
  echo "==> Starting frontend (port 3000)"
  npm run frontend:dev &
  FRONTEND_PID=$!
fi

# ─── Banner ────────────────────────────────────────────────────────────────
sleep 1
cat <<EOF

╔════════════════════════════════════════════════════════════════╗
║  OpenX · full-stack dev mode                                   ║
╠════════════════════════════════════════════════════════════════╣
║  Frontend          http://localhost:3000                       ║
║  API               http://localhost:3001                       ║
║  Health            http://localhost:3001/health                ║
║  OpenAPI agent     http://localhost:3001/openapi.json          ║
╚════════════════════════════════════════════════════════════════╝

Press Ctrl+C to stop.
EOF

trap 'echo ""; echo "==> Stopping..."; kill ${API_PID} ${FRONTEND_PID} 2>/dev/null; wait 2>/dev/null; exit 0' INT TERM
wait
