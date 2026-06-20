/**
 * loop/subscription — PTB builders for `openx_loop_subscription`.
 *
 * PRD-X6 closes W-B5/G9 — `routes/v3-loop.ts:435` currently synthesizes
 * `subscription_object_id` locally. These builders emit real Move calls so
 * the on-chain `LoopSubscription<USDC>` shared object holds buyer escrow,
 * the operator pulls per-run via `RunnerCap`, and cancel atomically refunds
 * remaining balance to the buyer's wallet.
 *
 * Move targets (from packages/sui-contracts/sources/openx_loop_subscription.move):
 *
 *   public entry fun create_subscription<T>(
 *     agent: &Agent,
 *     template_walrus_blob_id: vector<u8>,
 *     area_slug: vector<u8>,
 *     cron_utc_minute: u32,
 *     runs: u32,
 *     max_per_run_micro: u64,
 *     budget: Coin<T>,
 *     clock: &Clock,
 *     ctx: &mut TxContext,
 *   )
 *
 *   public entry fun cancel_subscription<T>(
 *     subscription: &mut LoopSubscription<T>,
 *     clock: &Clock,
 *     ctx: &mut TxContext,
 *   )
 *
 * SOLID:
 *   - SRP: two pure builders. Buyer-signed cancel = atomic refund (no
 *     operator custody) per Master PRD §5.2 design (a).
 *   - DIP: packageId + usdcCoinType + buyer-funded budgetCoinObjectId
 *     all caller-provided.
 */

import { Transaction } from '@mysten/sui/transactions';

const utf8 = (s: string): number[] => Array.from(new TextEncoder().encode(s));

export interface BuildCreateSubscriptionArgs {
  packageId: string;
  /** Fully-qualified USDC coin type, e.g. `0x...::usdc::USDC`. */
  usdcCoinType: string;
  agentObjectId: string;
  templateWalrusBlobId: string;
  areaSlug: string;
  /** Cron tick in UTC minutes, 0..1439 (e.g. 540 = 09:00 UTC). */
  cronUtcMinute: number;
  /** Number of scheduled runs, 1..366. */
  runs: number;
  /** Per-run cap in micro USDC. */
  maxPerRunMicro: bigint;
  /** Buyer-owned `Coin<USDC>` of size = runs × maxPerRunMicro. */
  budgetCoinObjectId: string;
  clockObjectId?: string;
}

export function buildCreateSubscriptionPtb(args: BuildCreateSubscriptionArgs): Transaction {
  if (args.cronUtcMinute < 0 || args.cronUtcMinute >= 1440) {
    throw new Error('subscription: cronUtcMinute must be 0..1439');
  }
  if (args.runs < 1 || args.runs > 366) {
    throw new Error('subscription: runs must be 1..366');
  }
  if (args.maxPerRunMicro <= 0n) {
    throw new Error('subscription: maxPerRunMicro must be > 0');
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${args.packageId}::openx_loop_subscription::create_subscription`,
    typeArguments: [args.usdcCoinType],
    arguments: [
      tx.object(args.agentObjectId),
      tx.pure.vector('u8', utf8(args.templateWalrusBlobId)),
      tx.pure.vector('u8', utf8(args.areaSlug)),
      tx.pure.u32(args.cronUtcMinute),
      tx.pure.u32(args.runs),
      tx.pure.u64(args.maxPerRunMicro),
      tx.object(args.budgetCoinObjectId),
      tx.object(args.clockObjectId ?? '0x6'),
    ],
  });
  return tx;
}

export interface BuildCancelSubscriptionArgs {
  packageId: string;
  usdcCoinType: string;
  /** `LoopSubscription<USDC>` shared object id created at create-time. */
  subscriptionObjectId: string;
  clockObjectId?: string;
}

export function buildCancelSubscriptionPtb(args: BuildCancelSubscriptionArgs): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${args.packageId}::openx_loop_subscription::cancel_subscription`,
    typeArguments: [args.usdcCoinType],
    arguments: [
      tx.object(args.subscriptionObjectId),
      tx.object(args.clockObjectId ?? '0x6'),
    ],
  });
  return tx;
}
