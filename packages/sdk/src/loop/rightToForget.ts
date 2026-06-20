/**
 * loop/rightToForget — PTB builder for `openx_loop_workflow_v1_1::delete_per_buyer_memory`.
 *
 * PRD-X6 closes G3 — `services/loop/rightToForgetService.ts:118` has an empty
 * `purgeNamespaces` callback. This builder emits the operator-gated Move
 * call that records `RightToForgetEmitted` on-chain after the 7-day cooling
 * off; the actual namespace purge happens off-chain via the existing service.
 *
 * Move target (entry function ADDED to existing `openx_loop_workflow_v1_1.move`
 * in this PRD — only ADDITIVE Move change in the package; existing 6 modules
 * stay byte-identical per PRD-W invariant):
 *
 *   public entry fun delete_per_buyer_memory(
 *     _runner: &RunnerCap,                  // operator-only
 *     agent: &Agent,
 *     buyer_addr: address,
 *     cooling_off_days: u8,
 *     _ctx: &mut TxContext,
 *   )
 *
 * The RunnerCap requirement makes this builder operator-signed (not buyer-
 * signed) — the buyer's prior `request_to_forget` call gates the action,
 * and the cooling-off enforced both off-chain (cron) and on-chain (entry
 * fun aborts when cooling_off_days < 7) gives auditor-grade compliance proof.
 *
 * SOLID: SRP — one moveCall layout. No signing here.
 */

import { Transaction } from '@mysten/sui/transactions';

export interface BuildDeletePerBuyerMemoryArgs {
  packageId: string;
  /** Operator's `RunnerCap` object id (held only by the operator wallet). */
  runnerCapObjectId: string;
  agentObjectId: string;
  /** Sui address whose per-buyer slot is being deleted. */
  buyerAddr: string;
  /** Days elapsed between buyer's request and execution. Minimum 7. */
  coolingOffDays: number;
}

export function buildDeletePerBuyerMemoryPtb(
  args: BuildDeletePerBuyerMemoryArgs,
): Transaction {
  if (args.coolingOffDays < 7 || args.coolingOffDays > 255) {
    throw new Error('rightToForget: coolingOffDays must be 7..255');
  }
  if (!args.buyerAddr.startsWith('0x') || args.buyerAddr.length !== 66) {
    throw new Error('rightToForget: buyerAddr must be a Sui hex address');
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${args.packageId}::openx_loop_workflow_v1_1::delete_per_buyer_memory`,
    arguments: [
      tx.object(args.runnerCapObjectId),
      tx.object(args.agentObjectId),
      tx.pure.address(args.buyerAddr),
      tx.pure.u8(args.coolingOffDays),
    ],
  });
  return tx;
}
