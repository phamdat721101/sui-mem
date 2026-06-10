#!/usr/bin/env bash
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> Building SDK..."
npm run sdk:build

echo "==> Building API..."
npm run api:build

echo "==> Building frontend..."
npm run frontend:build

echo "==> Starting API (port 3001)..."
npm run api:start &
API_PID=$!

for i in $(seq 1 15); do
  curl -sf http://localhost:3001/health >/dev/null 2>&1 && break
  sleep 1
done

echo "==> Starting frontend (port 3000)..."
npm run frontend:start &
FRONTEND_PID=$!

echo ""
echo "App running:"
echo "  Frontend : http://localhost:3000"
echo "  API      : http://localhost:3001"
echo "  Health   : http://localhost:3001/health"
echo ""
echo "Press Ctrl+C to stop."

trap "kill $API_PID $FRONTEND_PID 2>/dev/null" EXIT INT TERM
wait
