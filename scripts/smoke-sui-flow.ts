/**
 * scripts/smoke-sui-flow.ts — Sui-tier identity binding smoke test.
 *
 * Validates the new /v3/identity/link endpoint end-to-end with a real
 * @mysten/sui ed25519 keypair. Does NOT require a running Sui chain or
 * a frontend — just the Express API on :3001.
 *
 * Steps:
 *   1. Generate an ephemeral Sui keypair.
 *   2. Sign the canonical message with the Sui key.
 *   3. POST /v3/identity/link with a fake EVM address as the wallet header.
 *   4. GET /v3/identity/me — should round-trip the binding.
 *   5. Replay defense: re-sign with an expired ts, expect 400.
 *
 * Run:   tsx scripts/smoke-sui-flow.ts
 */

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

const API = process.env.OPENX_API_URL ?? 'http://localhost:3001';

function canonicalMessage(evm: string, sui: string, nonce: string, ts: number): string {
  return `openx-link-sui:${evm.toLowerCase()}:${sui.toLowerCase()}:${nonce}:${ts}`;
}

async function step(label: string, fn: () => Promise<unknown>): Promise<unknown> {
  process.stdout.write(`  ${label} … `);
  try {
    const r = await fn();
    process.stdout.write('OK\n');
    return r;
  } catch (err) {
    process.stdout.write(`FAIL\n    ${(err as Error).message}\n`);
    process.exit(1);
  }
}

async function main() {
  console.log(`smoke-sui-flow → ${API}`);

  const evm = '0x' + 'a'.repeat(40);
  const kp = new Ed25519Keypair();
  const sui = kp.toSuiAddress();
  const nonce = crypto.randomUUID();
  const ts = Date.now();
  const msg = new TextEncoder().encode(canonicalMessage(evm, sui, nonce, ts));
  const { signature } = await kp.signPersonalMessage(msg);

  await step('POST /v3/identity/link (happy path)', async () => {
    const r = await fetch(`${API}/v3/identity/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-wallet-address': evm },
      body: JSON.stringify({ suiAddress: sui, signature, nonce, ts }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
    const body = await r.json();
    if (body.suiAddress !== sui.toLowerCase()) throw new Error('roundtrip mismatch');
  });

  await step('GET /v3/identity/me', async () => {
    const r = await fetch(`${API}/v3/identity/me`, {
      headers: { 'x-wallet-address': evm },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = await r.json();
    if (!body.bound) throw new Error('binding missing');
    if (body.sui_address !== sui.toLowerCase()) throw new Error('binding mismatch');
  });

  await step('POST /v3/identity/link (replay — expired ts → 400)', async () => {
    const oldTs = Date.now() - 10 * 60 * 1000; // 10 minutes ago
    const oldNonce = crypto.randomUUID();
    const oldMsg = new TextEncoder().encode(canonicalMessage(evm, sui, oldNonce, oldTs));
    const { signature: oldSig } = await kp.signPersonalMessage(oldMsg);
    const r = await fetch(`${API}/v3/identity/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-wallet-address': evm },
      body: JSON.stringify({ suiAddress: sui, signature: oldSig, nonce: oldNonce, ts: oldTs }),
    });
    if (r.status !== 400) throw new Error(`expected 400, got ${r.status}`);
  });

  await step('POST /v3/identity/link (bad signature → 400)', async () => {
    const r = await fetch(`${API}/v3/identity/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-wallet-address': evm },
      body: JSON.stringify({
        suiAddress: sui,
        signature: 'AAAA' + signature.slice(4), // tamper
        nonce,
        ts,
      }),
    });
    if (r.status !== 400) throw new Error(`expected 400, got ${r.status}`);
  });

  console.log('\n✓ all checks passed');
}

main().catch((err) => {
  console.error('smoke-sui-flow:fatal', err);
  process.exit(1);
});
