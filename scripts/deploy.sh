#!/bin/bash
set -e

echo "==> FHE Second Brain v2.0 — Production Deploy"

# Check required env
if [ ! -f .env ]; then
  echo "No .env found. Creating from template..."
  cp .env.example .env
  echo "⚠ Edit .env with your values, then re-run this script."
  exit 1
fi

# Validate critical vars
source .env 2>/dev/null || true
for var in DATABASE_URL PLATFORM_WALLET BRAIN_KEY_VAULT_ADDRESS ARBITRUM_SEPOLIA_RPC NEXT_PUBLIC_BRAIN_KEY_VAULT_V2_ADDRESS; do
  if [ -z "${!var}" ]; then
    echo "✗ Missing required: $var"
    exit 1
  fi
done

# Pull latest
git pull origin main 2>/dev/null || true

# Build
echo "==> Building packages..."
npm run build

# Build containers
echo "==> Building Docker images..."
docker compose build --parallel

# Start
echo "==> Starting services..."
docker compose up -d --remove-orphans

# Run migrations
echo "==> Running migrations..."
for f in packages/shared/migrations/*.sql; do
  docker compose exec -T postgres psql "$DATABASE_URL" < "$f" 2>/dev/null || true
done

# Health check with retry
echo "==> Health check..."
for i in 1 2 3 4 5; do
  if curl -sf http://localhost:3001/health >/dev/null 2>&1; then
    echo "✓ API healthy"
    break
  fi
  sleep 3
done

echo ""
echo "=== FHE Second Brain v2.0 Running ==="
echo "  Frontend: http://localhost:3000 (/brain, /catalog, /settings-v2)"
echo "  API:      http://localhost:3001 (/v2/upload, /v2/inference, /v2/brains)"
echo "  Health:   http://localhost:3001/health"
echo "  Metrics:  http://localhost:3001/metrics"
echo ""
echo "Logs: docker compose logs -f"
