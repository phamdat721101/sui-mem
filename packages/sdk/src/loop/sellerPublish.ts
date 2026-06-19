/**
 * loop/sellerPublish — PTB builder for `openx_loop_agent_registry::publish_agent`.
 *
 * Returns a `@mysten/sui` `Transaction` instance the caller signs (or hands to
 * a sponsored-tx orchestrator). Pure builder — no signing, no submit.
 *
 * SOLID:
 *   - SRP: this file owns the Move-call argument layout. Nothing else.
 *   - DIP: caller passes `packageId` explicitly; no env reads.
 */

import { Transaction } from '@mysten/sui/transactions';

export interface BuildPublishAgentArgs {
  /** Sui package id of `fhe_brain` after deploy. */
  packageId: string;
  /** Walrus blob id of the canonical manifest YAML. */
  manifestWalrusBlobId: string;
  defaultInferenceBackend?: string;   // default 'phala-tee'
  defaultModelId?: string;            // default 'claude-opus-4.6'
  perIterMinMicroUsdc: bigint;
  perIterDefaultMicroUsdc: bigint;
  maxIterPerJob: number;              // 1..50
  /** Splits in bps. Sum must equal 10_000. */
  sellerBps?: number;                 // default 7000
  computeBps?: number;                // default 2500
  platformBps?: number;               // default 500
  clockObjectId?: string;             // default '0x6'
}

export function buildPublishAgentPtb(args: BuildPublishAgentArgs): Transaction {
  const tx = new Transaction();
  const sellerBps = args.sellerBps ?? 7000;
  const computeBps = args.computeBps ?? 2500;
  const platformBps = args.platformBps ?? 500;
  if (sellerBps + computeBps + platformBps !== 10_000) {
    throw new Error('loop:sellerPublish: splits must sum to 10_000');
  }
  if (args.maxIterPerJob < 1 || args.maxIterPerJob > 50) {
    throw new Error('loop:sellerPublish: maxIterPerJob must be in [1, 50]');
  }
  if (args.perIterDefaultMicroUsdc < args.perIterMinMicroUsdc) {
    throw new Error('loop:sellerPublish: perIterDefault < perIterMin');
  }

  tx.moveCall({
    target: `${args.packageId}::openx_loop_agent_registry::publish_agent`,
    arguments: [
      tx.pure.vector('u8', Array.from(new TextEncoder().encode(args.manifestWalrusBlobId))),
      tx.pure.vector('u8', Array.from(new TextEncoder().encode(args.defaultInferenceBackend ?? 'phala-tee'))),
      tx.pure.vector('u8', Array.from(new TextEncoder().encode(args.defaultModelId ?? 'claude-opus-4.6'))),
      tx.pure.u64(args.perIterMinMicroUsdc),
      tx.pure.u64(args.perIterDefaultMicroUsdc),
      tx.pure.u64(BigInt(args.maxIterPerJob)),
      tx.pure.u16(sellerBps),
      tx.pure.u16(computeBps),
      tx.pure.u16(platformBps),
      tx.object(args.clockObjectId ?? '0x6'),
    ],
  });
  return tx;
}

// ─── v2: publish with $1 USDC fee + Bedrock whitelist enforcement ─────

const PUBLISH_FEE_MICRO_USDC = 1_000_000n;

export interface BuildPublishAgentWithFeeArgs extends BuildPublishAgentArgs {
  /** Shared `BedrockModelRegistry` object id. */
  bedrockRegistryObjectId: string;
  /** USDC `Coin<T>` object id owned by the seller — provides the $1 fee. */
  feeCoinObjectId: string;
  /** Admin address that receives the fee. */
  adminAddr: string;
  /** Fully-qualified USDC coin type, e.g. `0x...::usdc::USDC`. */
  feeUsdcType: string;
}

/**
 * Build the v2 publish PTB: splits exactly 1 USDC from `feeCoinObjectId`,
 * transfers it to admin atomically with `Agent` creation, validates the
 * model id against the on-chain whitelist. Single signature, all-or-nothing.
 */
export function buildPublishAgentWithFeePtb(args: BuildPublishAgentWithFeeArgs): Transaction {
  const tx = new Transaction();
  const sellerBps = args.sellerBps ?? 7000;
  const computeBps = args.computeBps ?? 2500;
  const platformBps = args.platformBps ?? 500;
  if (sellerBps + computeBps + platformBps !== 10_000) {
    throw new Error('loop:sellerPublish: splits must sum to 10_000');
  }
  if (args.maxIterPerJob < 1 || args.maxIterPerJob > 50) {
    throw new Error('loop:sellerPublish: maxIterPerJob must be in [1, 50]');
  }
  if (args.perIterDefaultMicroUsdc < args.perIterMinMicroUsdc) {
    throw new Error('loop:sellerPublish: perIterDefault < perIterMin');
  }
  if (!args.defaultModelId) {
    throw new Error('loop:sellerPublish: defaultModelId required for v2 publish');
  }

  // Split exactly 1 USDC from the source coin. Remainder auto-returns to seller.
  const [feeCoin] = tx.splitCoins(tx.object(args.feeCoinObjectId), [
    tx.pure.u64(PUBLISH_FEE_MICRO_USDC),
  ]);

  tx.moveCall({
    target: `${args.packageId}::openx_loop_agent_registry::publish_agent_with_fee`,
    typeArguments: [args.feeUsdcType],
    arguments: [
      tx.object(args.bedrockRegistryObjectId),
      feeCoin,
      tx.pure.address(args.adminAddr),
      tx.pure.vector('u8', Array.from(new TextEncoder().encode(args.manifestWalrusBlobId))),
      tx.pure.vector('u8', Array.from(new TextEncoder().encode(args.defaultInferenceBackend ?? 'phala-tee'))),
      tx.pure.vector('u8', Array.from(new TextEncoder().encode(args.defaultModelId))),
      tx.pure.u64(args.perIterMinMicroUsdc),
      tx.pure.u64(args.perIterDefaultMicroUsdc),
      tx.pure.u64(BigInt(args.maxIterPerJob)),
      tx.pure.u16(sellerBps),
      tx.pure.u16(computeBps),
      tx.pure.u16(platformBps),
      tx.object(args.clockObjectId ?? '0x6'),
    ],
  });
  return tx;
}

// ─── Mutations: pricing / model / manifest / attest / revoke ──────────

export interface BuildUpdatePricingArgs {
  packageId: string;
  agentObjectId: string;
  perIterMinMicroUsdc: bigint;
  perIterDefaultMicroUsdc: bigint;
  maxIterPerJob: number;
  clockObjectId?: string;
}

export function buildUpdatePricingPtb(args: BuildUpdatePricingArgs): Transaction {
  const tx = new Transaction();
  if (args.maxIterPerJob < 1 || args.maxIterPerJob > 50) {
    throw new Error('loop:updatePricing: maxIterPerJob must be in [1, 50]');
  }
  if (args.perIterDefaultMicroUsdc < args.perIterMinMicroUsdc) {
    throw new Error('loop:updatePricing: perIterDefault < perIterMin');
  }
  tx.moveCall({
    target: `${args.packageId}::openx_loop_agent_registry::update_pricing`,
    arguments: [
      tx.object(args.agentObjectId),
      tx.pure.u64(args.perIterMinMicroUsdc),
      tx.pure.u64(args.perIterDefaultMicroUsdc),
      tx.pure.u64(BigInt(args.maxIterPerJob)),
      tx.object(args.clockObjectId ?? '0x6'),
    ],
  });
  return tx;
}

export interface BuildUpdateModelArgs {
  packageId: string;
  agentObjectId: string;
  bedrockRegistryObjectId: string;
  newModelId: string;
  clockObjectId?: string;
}

export function buildUpdateModelPtb(args: BuildUpdateModelArgs): Transaction {
  if (!args.newModelId) throw new Error('loop:updateModel: newModelId required');
  const tx = new Transaction();
  tx.moveCall({
    target: `${args.packageId}::openx_loop_agent_registry::update_model`,
    arguments: [
      tx.object(args.agentObjectId),
      tx.object(args.bedrockRegistryObjectId),
      tx.pure.vector('u8', Array.from(new TextEncoder().encode(args.newModelId))),
      tx.object(args.clockObjectId ?? '0x6'),
    ],
  });
  return tx;
}

export interface BuildUpdateManifestArgs {
  packageId: string;
  agentObjectId: string;
  newWalrusBlobId: string;
  manifestSha256: Uint8Array;
  clockObjectId?: string;
}

export function buildUpdateManifestPtb(args: BuildUpdateManifestArgs): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${args.packageId}::openx_loop_agent_registry::update_manifest`,
    arguments: [
      tx.object(args.agentObjectId),
      tx.pure.vector('u8', Array.from(new TextEncoder().encode(args.newWalrusBlobId))),
      tx.pure.vector('u8', Array.from(args.manifestSha256)),
      tx.object(args.clockObjectId ?? '0x6'),
    ],
  });
  return tx;
}

export interface BuildAttestManifestArgs {
  packageId: string;
  agentObjectId: string;
  manifestSha256: Uint8Array;
  clockObjectId?: string;
}

export function buildAttestManifestHashPtb(args: BuildAttestManifestArgs): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${args.packageId}::openx_loop_agent_registry::attest_manifest_hash`,
    arguments: [
      tx.object(args.agentObjectId),
      tx.pure.vector('u8', Array.from(args.manifestSha256)),
      tx.object(args.clockObjectId ?? '0x6'),
    ],
  });
  return tx;
}

export interface BuildRevokeAgentArgs {
  packageId: string;
  agentObjectId: string;
}

export function buildRevokeAgentPtb(args: BuildRevokeAgentArgs): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${args.packageId}::openx_loop_agent_registry::revoke_agent`,
    arguments: [tx.object(args.agentObjectId)],
  });
  return tx;
}

// ─── Admin (operator wallet only) ─────────────────────────────────────

export interface BuildAdminWhitelistModelArgs {
  packageId: string;
  adminCapObjectId: string;
  bedrockRegistryObjectId: string;
  modelId: string;
  clockObjectId?: string;
}

export function buildAdminWhitelistModelPtb(args: BuildAdminWhitelistModelArgs): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${args.packageId}::openx_loop_agent_registry::admin_whitelist_model`,
    arguments: [
      tx.object(args.adminCapObjectId),
      tx.object(args.bedrockRegistryObjectId),
      tx.pure.vector('u8', Array.from(new TextEncoder().encode(args.modelId))),
      tx.object(args.clockObjectId ?? '0x6'),
    ],
  });
  return tx;
}

export function buildAdminRemoveWhitelistModelPtb(args: BuildAdminWhitelistModelArgs): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${args.packageId}::openx_loop_agent_registry::admin_remove_whitelist_model`,
    arguments: [
      tx.object(args.adminCapObjectId),
      tx.object(args.bedrockRegistryObjectId),
      tx.pure.vector('u8', Array.from(new TextEncoder().encode(args.modelId))),
      tx.object(args.clockObjectId ?? '0x6'),
    ],
  });
  return tx;
}
