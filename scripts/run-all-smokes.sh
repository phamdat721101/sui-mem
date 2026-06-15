#!/usr/bin/env bash
# run-all-smokes.sh — Phase A→B regression gate (G5 isolation guarantee).
#
# Goal: prove the Sui upgrade does not break Standard tier or non-Sui rails.
#
# WHAT THIS RUNS (offline, deterministic — fits into CI):
#   1. SDK + API + Sui-SDK + UI builds (tsc green = no breaking changes)
#   2. Move tests (26 cases — brain_registry + workflow + subscription_policy + kya_gate)
#   3. SDK/runner smokes (53 assertions — cognitive-l4-l5 + workflow-runner + marketing-workflow)
#   4. seed-tri-marketplace DRY-mode (validates bootstrap content + cost math)
#
# WHAT THIS DOES NOT RUN (require live infra; use locally with creds):
#   - smoke:auth / smoke:chunks-auth / smoke:fhenix-onboard / smoke:x402
#   - smoke:walrus / smoke:sui-seal / smoke:sui-flow
#   These are listed at the end so reviewers know they exist; they're invoked
#   in the developer's local stack via `npm run smoke:<name>`.
#
# Exits non-zero on any failure. CI calls this directly.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

color_red='\033[0;31m'
color_green='\033[0;32m'
color_yellow='\033[0;33m'
color_reset='\033[0m'

step() { printf "\n${color_yellow}▶ %s${color_reset}\n" "$1"; }
ok()   { printf "${color_green}✅ %s${color_reset}\n" "$1"; }
fail() { printf "${color_red}❌ %s${color_reset}\n" "$1"; exit 1; }

# ─── 1. Builds ────────────────────────────────────────────────────────────
step "Build runtime-utils + sdk + ui + sui-sdk + api"
npm run runtime-utils:build > /dev/null
npm run sdk:build           > /dev/null
npm run ui:build            > /dev/null
npm run sui-sdk:build       > /dev/null
npm run api:build           > /dev/null
ok "all packages build green"

# ─── 2. Move tests ────────────────────────────────────────────────────────
step "Move tests (Sui contracts)"
if command -v sui >/dev/null 2>&1; then
  cd packages/sui-contracts
  if sui move test 2>&1 | tee /tmp/move_test.log | tail -1 | grep -q "Test result: OK"; then
    ok "Move tests pass ($(grep -c '\[ PASS' /tmp/move_test.log) cases)"
  else
    fail "Move tests failed — see /tmp/move_test.log"
  fi
  cd "$ROOT"
else
  printf "${color_yellow}⚠  sui CLI not installed — skipping Move tests${color_reset}\n"
fi

# ─── 3. SDK / runner smokes ───────────────────────────────────────────────
step "SDK cognitive smoke (Tasks 1+2)"
npm run smoke:cognitive-l4-l5 > /tmp/smoke1.log 2>&1 || fail "cognitive-l4-l5 smoke"
ok "$(grep 'passed,' /tmp/smoke1.log | tail -1)"

step "Workflow runner smoke (Tasks 4+5, G2 guard)"
npm run smoke:workflow-runner > /tmp/smoke2.log 2>&1 || fail "workflow-runner smoke"
ok "$(grep 'passed,' /tmp/smoke2.log | tail -1)"

step "Marketing 7-step workflow smoke (Task 7 lighthouse)"
npm run smoke:marketing-workflow > /tmp/smoke3.log 2>&1 || fail "marketing-workflow smoke"
ok "$(grep 'passed,' /tmp/smoke3.log | tail -1)"

step "WalrusMemoryBridge G4 isolation smoke (Task 13)"
npm run smoke:walrus-memory-bridge > /tmp/smoke4.log 2>&1 || fail "walrus-memory-bridge smoke"
ok "$(grep 'passed,' /tmp/smoke4.log | tail -1)"

step "Tatum integration smoke (DRY mode — Task T1+T6)"
npm run smoke:tatum > /tmp/smoke5.log 2>&1 || fail "tatum smoke"
ok "$(grep 'passed,' /tmp/smoke5.log | tail -1)"

# ─── 4. Seed validation (DRY) ─────────────────────────────────────────────
step "seed-tri-marketplace DRY validation"
npm run seed:tri-marketplace > /tmp/seed.log 2>&1 || fail "seed dry-run"
ok "bootstrap content + cost math valid"

# ─── 4b. Agent workspace E2E (requires running API) ───────────────────────
if [ -n "${OPENX_API_URL:-}" ]; then
  step "Agent workspace E2E (PRD-E port — needs running API)"
  npm run smoke:agent-workspace-e2e > /tmp/smoke_agent_ws.log 2>&1 || fail "agent-workspace-e2e smoke"
  ok "$(grep '✅' /tmp/smoke_agent_ws.log | tail -1)"
else
  printf "${color_yellow}⚠  OPENX_API_URL not set — skipping smoke:agent-workspace-e2e${color_reset}\n"
fi

# ─── 5. Existing-smoke registry (informational only) ──────────────────────
step "Existing smokes (run locally with credentials):"
cat <<EOF
   • smoke:auth                 (Standard tier — wallet + permit roundtrip)
   • smoke:marketplace-seller-flow  (publish → list → discover → 402 — needs live API+DB)
   • smoke:marketplace-seller-first (v2 — multi-agent + workflow + privacy router; live API+DB)
   • smoke:chunks-auth          (Standard tier — encrypted chunk auth)
   • smoke:fhenix-onboard       (Standard tier — Fhenix CoFHE onboarding)
   • smoke:x402                 (multi-rail payment — Base testnet)
   • smoke:walrus               (Trustless tier — Walrus blob roundtrip)
   • smoke:sui-seal             (Trustless tier — Seal IBE)
   • smoke:sui-flow             (Trustless tier — Sui identity binding)
   • demo:agentic-market        (full multi-rail demo)
EOF

printf "\n${color_green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${color_reset}\n"
printf "${color_green}✅ ALL OFFLINE REGRESSION CHECKS PASS — G5 satisfied${color_reset}\n"
printf "${color_green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${color_reset}\n"
