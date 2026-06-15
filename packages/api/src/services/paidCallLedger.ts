/**
 * paidCallLedger.ts — single insertion point for the `paid_calls` table.
 *
 * Idempotent on `(network, tx_hash)` — safe to call from multiple paths
 * (paywall middleware, /try free demo, /api/v1/<slug> paid path) without
 * worrying about double-counting on retries or concurrent settle.
 *
 * SOLID:
 *   - SRP: one insert. No reading, no aggregation, no rate logic.
 *   - DIP: pool injected via module-level import (matches the rest of services/).
 *   - OCP: a new method (e.g. `method='mpp'`) is just a new caller; this
 *     file doesn't change.
 */

import type { PoolClient } from 'pg';
import { pool } from '../db';
import { logger } from '../lib';

export type PaidCallMethod = 'demo' | 'exact' | 'mpp' | 'sui_usdc';

export interface PaidCallInput {
  agent_id: string;
  slug: string;
  buyer: string;
  amount_usdc: string; // decimal string; '0' for demo
  tx_hash: string;     // for demo: synthesize 'demo:<uuid>' so UNIQUE holds
  network: string;     // 'sui-testnet' | 'sui-mainnet' | 'demo'
  method: PaidCallMethod;
}

/**
 * Insert one paid_calls row. Returns true on insert, false if the
 * `(network, tx_hash)` row already existed (idempotent no-op).
 */
export async function record(
  input: PaidCallInput,
  client: PoolClient | typeof pool = pool,
): Promise<boolean> {
  try {
    const r = await client.query(
      `INSERT INTO paid_calls (agent_id, slug, buyer, amount_usdc, tx_hash, network, method)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (network, tx_hash) DO NOTHING
       RETURNING id`,
      [
        input.agent_id,
        input.slug,
        input.buyer.toLowerCase(),
        input.amount_usdc,
        input.tx_hash,
        input.network,
        input.method,
      ],
    );
    const inserted = (r.rowCount ?? 0) > 0;
    if (inserted) {
      logger.info(
        { tx_hash: input.tx_hash, slug: input.slug, method: input.method, amount: input.amount_usdc },
        'paid_calls:recorded',
      );
    }
    return inserted;
  } catch (e) {
    logger.warn({ err: (e as Error).message, input }, 'paid_calls:record:failed');
    return false;
  }
}

/**
 * Synthetic tx_hash for demo (free) rows. Deterministic on (slug, ts, payer)
 * so a network blip retry de-dupes via the UNIQUE (network, tx_hash) constraint.
 */
export function demoTxHash(slug: string, payer: string): string {
  const ts = Math.floor(Date.now() / 1000);
  return `demo:${slug}:${payer.slice(0, 10)}:${ts}`;
}
