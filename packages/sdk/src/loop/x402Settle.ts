/**
 * loop/x402Settle — Mode A wire-format helpers.
 *
 * Two exports:
 *   - `parse402Challenge(response)` — pulls the PTB-bytes envelope out of a
 *     402 response from `POST /v3/loop/agents/:id/invoke`.
 *   - `buildSettleAndDistributePtb({ ... })` — produces a `Transaction`
 *     calling `openx_loop_x402_router::settle_and_distribute<USDC>`.
 *
 * Both are pure (no I/O) so they compose cleanly in the frontend hook
 * (`useSuiSponsoredPay`) and in tests.
 */

import { Transaction } from '@mysten/sui/transactions';

// ─── Challenge envelope ───────────────────────────────────────────────────

/** Shape returned by `loopX402Middleware()` when X-PAYMENT is missing. */
export interface LoopX402Challenge {
  /** base64 PTB bytes pre-built by the server. */
  ptb_bytes_b64: string;
  agent_object_id: string;
  amount_micro_usdc: string;            // u64 as string
  manifest_walrus_blob_id: string;
  network: 'sui-testnet' | 'sui-mainnet';
  resource: string;
  /** challenge id; HMAC-signed; submitted back in X-PAYMENT for replay-defence. */
  challenge_id: string;
  expires_at_ms: number;
}

export interface Loop402ResponseLike {
  status: number;
  json: () => Promise<unknown>;
}

export async function parse402Challenge(response: Loop402ResponseLike): Promise<LoopX402Challenge | null> {
  if (response.status !== 402) return null;
  const body = (await response.json()) as Partial<LoopX402Challenge>;
  if (!body || typeof body.ptb_bytes_b64 !== 'string') return null;
  return body as LoopX402Challenge;
}

// ─── Settle PTB builder ───────────────────────────────────────────────────

export interface BuildSettleArgs {
  packageId: string;
  routerConfigObjectId: string;
  agentObjectId: string;
  /** Buyer's `Coin<USDC>` object id. The PTB consumes it exactly. */
  paymentCoinObjectId: string;
  /** USDC type tag, e.g. `0x2::usdc::USDC` (Sui Mainnet) or test stand-in. */
  usdcCoinType: string;
  buyerAddress: string;
  clockObjectId?: string;     // default '0x6'
}

export function buildSettleAndDistributePtb(args: BuildSettleArgs): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${args.packageId}::openx_loop_x402_router::settle_and_distribute`,
    typeArguments: [args.usdcCoinType],
    arguments: [
      tx.object(args.routerConfigObjectId),
      tx.object(args.agentObjectId),
      tx.object(args.paymentCoinObjectId),
      tx.pure.address(args.buyerAddress),
      tx.object(args.clockObjectId ?? '0x6'),
    ],
  });
  return tx;
}
