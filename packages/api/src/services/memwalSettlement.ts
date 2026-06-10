/**
 * memwalSettlement.ts — periodic settlement worker for paid MemWal queries.
 *
 * Every `intervalMs` (default 60s) the worker:
 *   1. Groups un-settled `memwal_paid_queries` rows by `brain_sui_object_id`.
 *   2. Calls `operator.settleBatch(...)` to emit the on-chain `SettlementBatchEmitted` event.
 *   3. Inserts a `memwal_revenue_settlements` row + tags the queries with the
 *      resulting `settlement_tx_hash`.
 *   4. Volume dial — `operator_bps` shrinks from 500→400→300→200 as the
 *      seller's rolling 30-day count crosses 100/1000/10000 paid queries.
 *
 * Real on-chain `revenue_split.distribute<T>` requires Coin<USDC> input which
 * the operator wallet does not currently custody for sellers. For Phase 2
 * we emit the billing event + ledger row; the payout fan-out is deferred to
 * Phase 4 once Sui mainnet USDC is wired (parking it as the simplest correct
 * thing to do today, per docs/V3_PROPOSAL.md mock-first table).
 *
 * SOLID:
 *  - SRP: this file owns ONE class — the worker. No HTTP, no Sui signing
 *    (delegated to MemWalOperator).
 *  - DIP: takes a Postgres pool + operator factory; tests can pass mocks.
 *  - OCP: adding a new dial threshold = one entry in `BPS_TIERS`.
 */

import type { Pool } from 'pg';
import { logger } from '../lib';
import { getMemWalOperator } from './memwalOperator';

interface PendingRow {
  brain_sui_object_id: string;
  amount_usdc: string;
  query_count: string;
  seller_wallet: string;
}

/** Volume dial — rolling 30-day count → operator BPS (out of 10_000). */
const BPS_TIERS: ReadonlyArray<{ minQueries: number; bps: number }> = [
  { minQueries: 10_000, bps: 200 },
  { minQueries: 1_000, bps: 300 },
  { minQueries: 100, bps: 400 },
  { minQueries: 0, bps: 500 },
];

export function operatorBpsFor(rollingCount30d: number): number {
  for (const t of BPS_TIERS) if (rollingCount30d >= t.minQueries) return t.bps;
  return 500; // unreachable; keeps the function total
}

export interface SettlementWorkerConfig {
  pool: Pool;
  intervalMs?: number;
  /** When false, the worker no-ops (e.g. on disabled environments). */
  enabled?: boolean;
}

export class MemWalSettlementWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** Set to true once we've detected the MemWal tables are missing. The
   *  worker auto-disables until the process restarts so a missing migration
   *  doesn't fill the log with errors every 60s. */
  private skipped = false;
  private readonly intervalMs: number;
  private readonly enabled: boolean;
  private readonly pool: Pool;

  constructor(cfg: SettlementWorkerConfig) {
    this.pool = cfg.pool;
    this.intervalMs = cfg.intervalMs ?? 60_000;
    this.enabled = cfg.enabled ?? true;
  }

  start(): void {
    if (!this.enabled) {
      logger.info('memwal:settlement:disabled');
      return;
    }
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    logger.info({ intervalMs: this.intervalMs }, 'memwal:settlement:started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One pass — exposed for tests + manual triggers via CLI. */
  async tick(): Promise<{ batches: number; queries: number }> {
    if (this.running) return { batches: 0, queries: 0 };
    if (this.skipped) return { batches: 0, queries: 0 };
    this.running = true;
    const stats = { batches: 0, queries: 0 };
    try {
      const pending = await this.fetchPending();
      const op = getMemWalOperator();
      for (const row of pending) {
        const queryCount = Number(row.query_count);
        const totalUsdc = Number(row.amount_usdc);
        if (queryCount === 0) continue;
        const totalUsdcMicro = Math.round(totalUsdc * 1_000_000);
        const rollingCount = await this.rollingCount30d(row.seller_wallet);
        const operator_bps = operatorBpsFor(rollingCount);
        const operator_amount = (totalUsdc * operator_bps) / 10_000;
        const seller_amount = totalUsdc - operator_amount;

        // Best-effort on-chain settlement event (skipped when operator not configured).
        let settlementTxHash = `local-${Date.now()}-${row.brain_sui_object_id.slice(2, 10)}`;
        if (op) {
          try {
            const out = await op.settleBatch({
              brainSuiObjectId: row.brain_sui_object_id,
              batchSize: queryCount,
              totalUsdcMicro,
            });
            settlementTxHash = out.digest;
          } catch (e) {
            logger.warn(
              { err: (e as Error).message, brain: row.brain_sui_object_id },
              'memwal:settlement:onchain:failed',
            );
          }
        }

        await this.recordSettlement({
          brain: row.brain_sui_object_id,
          settlementTxHash,
          totalUsdc,
          queryCount,
          sellerWallet: row.seller_wallet,
          sellerAmount: seller_amount,
          operatorAmount: operator_amount,
          operatorBps: operator_bps,
        });
        stats.batches++;
        stats.queries += queryCount;
      }
      if (stats.batches > 0) {
        logger.info(stats, 'memwal:settlement:tick');
      }
      return stats;
    } catch (e) {
      // Postgres `42P01` = undefined_table. If the MemWal migrations
      // (016_memwal_accounts .. 021_memwal_revenue_settlements) haven't
      // been applied yet, log ONCE with an actionable message and
      // auto-disable until the process restarts. Same pattern as routes/v3.ts.
      if ((e as { code?: string })?.code === '42P01') {
        logger.error(
          { hint: 'apply migrations 016_memwal_accounts..021_memwal_revenue_settlements (e.g. via scripts/deploy.sh)' },
          'memwal:settlement:tables-missing — auto-disabling worker',
        );
        this.skipped = true;
        return stats;
      }
      logger.error({ err: (e as Error).message }, 'memwal:settlement:tick:error');
      return stats;
    } finally {
      this.running = false;
    }
  }

  // ─── private storage helpers ───────────────────────────────────────

  private async fetchPending(): Promise<PendingRow[]> {
    const r = await this.pool.query<PendingRow>(
      `SELECT q.brain_sui_object_id,
              SUM(q.amount_usdc)::text   AS amount_usdc,
              COUNT(*)::text             AS query_count,
              MIN(b.seller_wallet)       AS seller_wallet
       FROM memwal_paid_queries q
       JOIN memwal_marketplace_brains b ON b.sui_object_id = q.brain_sui_object_id
       WHERE q.settlement_tx_hash IS NULL AND q.refunded = false
       GROUP BY q.brain_sui_object_id
       ORDER BY MIN(q.created_at)
       LIMIT 50`,
    );
    return r.rows;
  }

  private async rollingCount30d(sellerWallet: string): Promise<number> {
    const r = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM memwal_paid_queries q
       JOIN memwal_marketplace_brains b ON b.sui_object_id = q.brain_sui_object_id
       WHERE b.seller_wallet = $1
         AND q.created_at > now() - interval '30 days'
         AND q.refunded = false`,
      [sellerWallet.toLowerCase()],
    );
    return Number(r.rows[0]?.count ?? 0);
  }

  private async recordSettlement(args: {
    brain: string;
    settlementTxHash: string;
    totalUsdc: number;
    queryCount: number;
    sellerWallet: string;
    sellerAmount: number;
    operatorAmount: number;
    operatorBps: number;
  }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO memwal_revenue_settlements (
           brain_sui_object_id, settlement_tx_hash, total_usdc, query_count,
           seller_wallet, seller_amount_usdc, operator_amount_usdc, operator_bps
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (settlement_tx_hash) DO NOTHING`,
        [
          args.brain,
          args.settlementTxHash,
          args.totalUsdc,
          args.queryCount,
          args.sellerWallet,
          args.sellerAmount,
          args.operatorAmount,
          args.operatorBps,
        ],
      );
      await client.query(
        `UPDATE memwal_paid_queries
         SET settlement_tx_hash = $2
         WHERE brain_sui_object_id = $1
           AND settlement_tx_hash IS NULL
           AND refunded = false`,
        [args.brain, args.settlementTxHash],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}
