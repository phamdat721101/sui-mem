/**
 * loop/upgradeWorkflow — PTB builder for `openx_loop_workflow_v1_1::init_extension`.
 *
 * PRD-X6 closes W-S2 (PTB) — the upgrade wizard at agent/[id]/upgrade/page.tsx
 * currently posts `workflow_walrus_blob_id: 'pending-on-chain-ptb'` instead
 * of emitting a real `init_extension` Move call. This builder produces the
 * Transaction the seller signs to create the `AgentV11Extension` shared
 * object on-chain.
 *
 * Move target shape (from packages/sui-contracts/sources/openx_loop_workflow_v1_1.move):
 *   public entry fun init_extension(
 *     agent: &Agent,
 *     workflow_walrus_blob_id: vector<u8>,
 *     stop_condition_walrus_blob_id: vector<u8>,
 *     area_slugs: vector<vector<u8>>,
 *     clock: &Clock,
 *     ctx: &mut TxContext,
 *   )
 *
 * SOLID:
 *   - SRP: this file owns ONE moveCall layout. No env reads, no signing.
 *   - DIP: caller passes packageId + agentObjectId explicitly.
 *   - OCP: subscription / rotate / persona-approve are sibling builders;
 *     adding a new extension method = a new sibling file, never edits here.
 */

import { Transaction } from '@mysten/sui/transactions';

const utf8 = (s: string): number[] => Array.from(new TextEncoder().encode(s));

export interface BuildInitExtensionArgs {
  /** Sui package id of `fhe_brain` (must include `openx_loop_workflow_v1_1`). */
  packageId: string;
  /** Existing Agent shared object id (the agent being upgraded). */
  agentObjectId: string;
  /** Walrus blob id of the workflow YAML pinned at upgrade time. */
  workflowWalrusBlobId: string;
  /** Walrus blob id of the stop_condition Predicate JSON. */
  stopConditionWalrusBlobId: string;
  /** PARA areas declared by the seller. 1..16 entries. */
  areaSlugs: string[];
  /** Defaults to '0x6' (Sui shared Clock). */
  clockObjectId?: string;
}

export function buildInitExtensionPtb(args: BuildInitExtensionArgs): Transaction {
  if (!args.areaSlugs.length || args.areaSlugs.length > 16) {
    throw new Error('upgradeWorkflow: areaSlugs must be 1..16');
  }
  if (!args.workflowWalrusBlobId || !args.stopConditionWalrusBlobId) {
    throw new Error('upgradeWorkflow: both blob ids required');
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${args.packageId}::openx_loop_workflow_v1_1::init_extension`,
    arguments: [
      tx.object(args.agentObjectId),
      tx.pure.vector('u8', utf8(args.workflowWalrusBlobId)),
      tx.pure.vector('u8', utf8(args.stopConditionWalrusBlobId)),
      tx.pure.vector('vector<u8>', args.areaSlugs.map(utf8)),
      tx.object(args.clockObjectId ?? '0x6'),
    ],
  });
  return tx;
}
