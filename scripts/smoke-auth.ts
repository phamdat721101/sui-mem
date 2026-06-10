#!/usr/bin/env tsx
/**
 * End-to-end auth smoke test against a running API + Arbitrum Sepolia.
 *
 * Env:
 *   API_URL          — default http://localhost:3001
 *   PRIVATE_KEY      — funded wallet on Arbitrum Sepolia
 *   PLATFORM_WALLET  — the platform address the vault trusts
 *   BRAIN_KEY_VAULT_ADDRESS
 *   ARBITRUM_SEPOLIA_RPC
 *
 * Usage: npm run smoke:auth
 */
import { ethers } from 'ethers';

const API = process.env.API_URL || 'http://localhost:3001';
const RPC = process.env.ARBITRUM_SEPOLIA_RPC || 'https://sepolia-rollup.arbitrum.io/rpc';
const VAULT = process.env.BRAIN_KEY_VAULT_ADDRESS!;
const PLATFORM = process.env.PLATFORM_WALLET!;
const PK = process.env.PRIVATE_KEY!;

if (!VAULT || !PLATFORM || !PK) {
  console.error('Missing env: BRAIN_KEY_VAULT_ADDRESS, PLATFORM_WALLET, PRIVATE_KEY');
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(PK, provider);
const userAddress = wallet.address.toLowerCase();

const VAULT_ABI = [
  'function authorize(address platform)',
  'function revoke(address platform)',
  'function isAuthorized(address user, address platform) view returns (bool)',
];
const vault = new ethers.Contract(VAULT, VAULT_ABI, wallet);

async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (e: any) {
    console.error(`✗ ${name}: ${e.message}`);
    process.exit(1);
  }
}

async function main() {
  console.log(`Smoke test: ${userAddress} → ${API}\n`);

  // 1. On-chain authorize
  await step('BrainKeyVault.authorize(platform)', async () => {
    const isAuth = await vault.isAuthorized(wallet.address, PLATFORM);
    if (!isAuth) {
      const tx = await vault.authorize(PLATFORM);
      await tx.wait();
    }
  });

  // 2. Create SDK permit (simplified — use raw EIP-712 mock for smoke)
  // In production the frontend uses @cofhe/sdk createPermit. Here we test
  // the on-chain path by calling /permit/status directly.
  await step('/permit/status returns authorized', async () => {
    const r = await fetch(`${API}/permit/status?address=${userAddress}&refresh=1`);
    const data = await r.json();
    if (!data.authorized) throw new Error(`Not authorized: ${data.reason}`);
  });

  // 3. Test protected route without permit cache (should still pass via on-chain check)
  await step('/chat returns 402 (no subscription) — proves permit passed', async () => {
    const r = await fetch(`${API}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-wallet-address': userAddress },
      body: JSON.stringify({ message: 'test', mode: 'learn' }),
    });
    // 402 = permit passed, subscription gate caught it
    if (r.status !== 402) throw new Error(`Expected 402, got ${r.status}`);
  });

  // 4. Test v2 route gating
  await step('/v2/upload returns 402 (no subscription) — proves auth+permit passed', async () => {
    const r = await fetch(`${API}/v2/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-wallet-address': userAddress },
      body: JSON.stringify({ ciphertext: 'test', txHash: '0xabc' }),
    });
    if (r.status !== 402) throw new Error(`Expected 402, got ${r.status}`);
  });

  // 5. Test raw tx hash rejection
  await step('/permit/import rejects raw tx hash', async () => {
    const r = await fetch(`${API}/permit/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userAddress, serializedPermit: '0x' + 'a'.repeat(64) }),
    });
    if (r.status !== 400) throw new Error(`Expected 400, got ${r.status}`);
    const data = await r.json();
    if (data.reason !== 'parse_failed') throw new Error(`Expected parse_failed, got ${data.reason}`);
  });

  // 6. Test anonymous access
  await step('/chat returns 401 without wallet header', async () => {
    const r = await fetch(`${API}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'test' }),
    });
    if (r.status !== 401) throw new Error(`Expected 401, got ${r.status}`);
  });

  // 7. Revoke and verify rejection
  await step('BrainKeyVault.revoke(platform)', async () => {
    const tx = await vault.revoke(PLATFORM);
    await tx.wait();
  });

  await step('/permit/status returns unauthorized after revoke', async () => {
    const r = await fetch(`${API}/permit/status?address=${userAddress}&refresh=1`);
    const data = await r.json();
    if (data.authorized) throw new Error('Still authorized after revoke');
    if (!['permit_revoked', 'never_authorized'].includes(data.reason)) {
      throw new Error(`Unexpected reason: ${data.reason}`);
    }
  });

  await step('/chat returns 403 after revoke', async () => {
    const r = await fetch(`${API}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-wallet-address': userAddress },
      body: JSON.stringify({ message: 'test', mode: 'learn' }),
    });
    if (r.status !== 403) throw new Error(`Expected 403, got ${r.status}`);
  });

  // 8. Re-authorize for cleanup
  await step('Re-authorize (cleanup)', async () => {
    const tx = await vault.authorize(PLATFORM);
    await tx.wait();
  });

  console.log('\n✓ All smoke tests passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
