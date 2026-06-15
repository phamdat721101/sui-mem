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
