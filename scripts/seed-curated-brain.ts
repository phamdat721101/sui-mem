#!/usr/bin/env -S npx tsx
/**
 * seed-curated-brain.ts — OpenX launch-experiment honey pot.
 *
 * Per docs/USP_BRIEF.md §"30-day kill criteria" and PHASE1-REPORT §4.6:
 * we ship one curated public brain that any AI agent can query. This brain
 * is *intentionally* not v2-encrypted — it is the platform's curated demo
 * content, not user knowledge. Owner address is the platform wallet.
 *
 * Run: `tsx scripts/seed-curated-brain.ts`
 *      (DATABASE_URL must be set; uses packages/api's pool config.)
 */

import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config({ path: 'packages/api/.env' });

const PLATFORM_WALLET = (process.env.PLATFORM_WALLET ?? '').toLowerCase();
if (!PLATFORM_WALLET || !process.env.DATABASE_URL) {
  // eslint-disable-next-line no-console
  console.error('Missing DATABASE_URL or PLATFORM_WALLET. Set in packages/api/.env');
  process.exit(1);
}

const TITLE = 'FHE / ERC-8004 / Phala — curated reference brain';
const DESCRIPTION =
  'Curated public brain about FHE on Arbitrum (Fhenix CoFHE), ERC-8004 agent identity, ' +
  'and Phala Confidential AI. Free reference for AI agents discovering OpenX.';
const TAGS = ['fhe', 'fhenix', 'erc-8004', 'phala', 'tee', 'agents'];

const CHUNKS = [
  // Fhenix CoFHE
  'Fhenix CoFHE is an FHE coprocessor live on Ethereum Sepolia, Arbitrum Sepolia, and Base Sepolia. ' +
    'It exposes euint{8,16,32,64,128,256} types via @fhenixprotocol/cofhe-contracts/FHE.sol and a TypeScript client at @cofhe/sdk.',
  'BrainKeyVaultV2 (OpenX) on Arbitrum Sepolia stores per-brain AES-256-GCM key halves as two euint128 values. ' +
    'storeKey(brainId, eHigh, eLow) is the one-time gas operation; reads happen gaslessly via the threshold network.',
  'Fhenix permit pattern: getOrCreateSelfPermit (own data) and createSharing+importShared (share with platform). ' +
    'Permits are short-lived; revoking deletes the platform DB row and on-chain hasAccess flag.',
  // ERC-8004
  'ERC-8004 is the Ethereum standard for AI agent identity (mainnet Jan 29, 2026). ' +
    'Three lightweight registries — Identity, Reputation, Validation — deployed canonically on Ethereum, Base, BNB, Avalanche, Mantle. ' +
    'See geterc8004.com.',
  'ERC-8004 Identity registry exposes getAgent(uint agentId) returning (address owner, string agentURI). ' +
    'Read with viem: createPublicClient + http(rpcUrl) + readContract.',
  // Phala TEE
  'Phala Confidential AI runs OpenAI-compatible LLM inference inside Intel TDX / AMD SEV / NVIDIA TEE GPUs. ' +
    'Every response carries a hardware attestation; verifiers check GPU + container + model + runtime before trusting.',
  'Phala Cloud + Venice AI partnership (Nov 2026) shipped E2EE+TEE inference modes to a real consumer product. ' +
    'API endpoint pattern: <PHALA_ENDPOINT>/v1/chat/completions, attestation in x-attestation-quote header.',
  // OpenX USP
  'OpenX is the marketplace where AI agents pay in USDC to query FHE-encrypted second brains. ' +
    'Sellers publish a sentence; agents discover via /openapi.json with x-price-usdc and x-kya-required extensions.',
  'OpenX economic model: sellers earn $0.01 per query; the platform takes a fee from the buyer side; ' +
    'human sellers do NOT subscribe. Per-query x402 settlement, not seat-based SaaS.',
];

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    // Idempotent: only seed if no brain with this exact title exists.
    const existing = await pool.query<{ id: number }>(
      `SELECT id FROM brains WHERE title = $1 AND LOWER(owner_address) = $2 LIMIT 1`,
      [TITLE, PLATFORM_WALLET],
    );
    let brainId: number;
    if (existing.rows[0]) {
      brainId = existing.rows[0].id;
      // eslint-disable-next-line no-console
      console.log(`[seed] curated brain already exists: id=${brainId}`);
    } else {
      const inserted = await pool.query<{ id: number }>(
        `INSERT INTO brains (owner_address, title, description, tags, published, chain, privacy_version)
         VALUES ($1, $2, $3, $4, TRUE, 'arbitrum-sepolia', 1)
         RETURNING id`,
        [PLATFORM_WALLET, TITLE, DESCRIPTION, TAGS],
      );
      brainId = inserted.rows[0].id;
      for (let i = 0; i < CHUNKS.length; i += 1) {
        await pool.query(
          `INSERT INTO knowledge_chunks (brain_id, chunk_index, content, encrypted)
           VALUES ($1, $2, $3, FALSE)`,
          [brainId, i, CHUNKS[i]],
        );
      }
      // eslint-disable-next-line no-console
      console.log(`[seed] curated brain created: id=${brainId}, chunks=${CHUNKS.length}`);
    }
    // eslint-disable-next-line no-console
    console.log(`[seed] view at /brains/${brainId}; price 0.01 USDC/query (per /openapi.json)`);
  } finally {
    await pool.end();
  }
})().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[seed] failed:', err.message);
  process.exit(1);
});
