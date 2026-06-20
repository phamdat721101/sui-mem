/**
 * loop/personaApprove — PTB builders for seller-extension management.
 *
 * Two related PTBs paired in one file because both manage the seller's
 * `AgentV11Extension`:
 *
 *  1. `buildPersonaApprovePtb` — PRD-X8-thin closes G5 (persona auto-rewrite
 *     review UI). Seller approves a `persona_rewrite_proposals` row by
 *     signing `update_extension` with the proposed Walrus blob id.
 *
 *  2. `buildRotateDelegatePtb` — PRD-X8-thin closes G10 (W6 rotate UI).
 *     Atomically removes the old per-agent ed25519 delegate pubkey and
 *     adds the freshly-minted one.
 *
 * Move targets (from packages/sui-contracts/sources/openx_loop_workflow_v1_1.move
 * and openx_loop_agent_registry.move):
 *
 *   public entry fun update_extension(
 *     agent: &Agent,
 *     extension: &mut AgentV11Extension,
 *     new_persona_walrus_blob_id: vector<u8>,
 *     ctx: &mut TxContext,
 *   )
 *
 *   public entry fun rotate_delegate_key(
 *     agent: &mut Agent,
 *     old_pubkey_bytes: vector<u8>,
 *     new_pubkey_bytes: vector<u8>,
 *     clock: &Clock,
 *     ctx: &mut TxContext,
 *   )
 *
 * SOLID: SRP — pure builders. The "decision" half (which proposal to
 * approve, when to rotate) lives outside in the route handlers / cron.
 */

import { Transaction } from '@mysten/sui/transactions';

const utf8 = (s: string): number[] => Array.from(new TextEncoder().encode(s));

export interface BuildPersonaApproveArgs {
  packageId: string;
  agentObjectId: string;
  agentV11ExtensionObjectId: string;
  /** Walrus blob id of the proposed persona delta (from
   *  `persona_rewrite_proposals.proposed_walrus_blob_id`). */
  newPersonaWalrusBlobId: string;
}

export function buildPersonaApprovePtb(args: BuildPersonaApproveArgs): Transaction {
  if (!args.newPersonaWalrusBlobId) {
    throw new Error('personaApprove: newPersonaWalrusBlobId required');
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${args.packageId}::openx_loop_workflow_v1_1::update_extension`,
    arguments: [
      tx.object(args.agentObjectId),
      tx.object(args.agentV11ExtensionObjectId),
      tx.pure.vector('u8', utf8(args.newPersonaWalrusBlobId)),
    ],
  });
  return tx;
}

export interface BuildRotateDelegateArgs {
  packageId: string;
  agentObjectId: string;
  /** Hex-encoded ed25519 pubkey currently active. */
  oldPubkeyHex: string;
  /** Hex-encoded ed25519 pubkey freshly minted via prepareRotation. */
  newPubkeyHex: string;
  clockObjectId?: string;
}

const hexToBytes = (h: string): number[] => {
  const s = h.startsWith('0x') ? h.slice(2) : h;
  if (s.length % 2 !== 0) throw new Error('rotateDelegate: pubkey hex must be even length');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return Array.from(out);
};

export function buildRotateDelegatePtb(args: BuildRotateDelegateArgs): Transaction {
  if (!args.oldPubkeyHex || !args.newPubkeyHex) {
    throw new Error('rotateDelegate: both pubkeys required');
  }
  if (args.oldPubkeyHex === args.newPubkeyHex) {
    throw new Error('rotateDelegate: new pubkey must differ from old');
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${args.packageId}::openx_loop_agent_registry::rotate_delegate_key`,
    arguments: [
      tx.object(args.agentObjectId),
      tx.pure.vector('u8', hexToBytes(args.oldPubkeyHex)),
      tx.pure.vector('u8', hexToBytes(args.newPubkeyHex)),
      tx.object(args.clockObjectId ?? '0x6'),
    ],
  });
  return tx;
}
