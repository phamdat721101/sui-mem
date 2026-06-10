#!/usr/bin/env tsx
/**
 * smoke-chunks-auth — guards the v2 chunks-fetch auth contract.
 *
 * Reproduces the production bug (frontend hook missing `x-wallet-address`
 * header → 401) and proves the fix end-to-end:
 *   1) GET /v2/brains/:id/chunks  (no header)               → 401 expected
 *   2) GET /v2/brains/:id/chunks  (x-wallet-address: ...)   → 200 expected
 *
 * Env (all optional):
 *   API_URL         default http://localhost:3001
 *   BRAIN_ID        default 7  (the brain the user reproduced the bug on)
 *   WALLET_ADDRESS  default 0x0000000000000000000000000000000000000001
 *                   The auth middleware only checks the header is *present*;
 *                   it does not require a real funded wallet for this gate.
 *
 * Usage: npm run smoke:chunks-auth
 */

const API = (process.env.API_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const BRAIN_ID = process.env.BRAIN_ID ?? '7';
const WALLET = process.env.WALLET_ADDRESS ?? '0x0000000000000000000000000000000000000001';
const URL = `${API}/v2/brains/${BRAIN_ID}/chunks`;

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`\u2713 ${name}`);
  } catch (e: any) {
    console.error(`\u2717 ${name}: ${e?.message ?? e}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  console.log(`Smoke: ${URL}\n`);

  await step('unauthenticated request is rejected with 401', async () => {
    const r = await fetch(URL);
    if (r.status !== 401) throw new Error(`expected 401, got ${r.status}`);
    const body = await r.json().catch(() => ({}));
    if (body?.error !== 'Missing wallet address') {
      throw new Error(`expected error="Missing wallet address", got ${JSON.stringify(body)}`);
    }
  });

  await step('authenticated request returns chunks (200, array)', async () => {
    const r = await fetch(URL, { headers: { 'x-wallet-address': WALLET } });
    if (r.status !== 200) throw new Error(`expected 200, got ${r.status}`);
    const body = await r.json().catch(() => null);
    if (!Array.isArray(body)) throw new Error(`expected JSON array, got ${typeof body}`);
  });

  console.log('\nAll assertions passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
