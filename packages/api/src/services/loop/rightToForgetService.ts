/**
 * services/loop/rightToForgetService.ts — PRD-W v1.1 right-to-forget.
 *
 * Combined service + cron: route handlers call `request()` and `cancel()`;
 * the 0500 UTC cron calls `executeStale()` which atomically deletes the
 * per-buyer slot via the Move entry `delete_per_buyer_memory<T>`. The
 * seller's GENERAL brain (`cog-l4-{agent_id}`) is UNTOUCHED — only the
 * per-buyer namespace pair (cog-l4 + cog-l5 for that buyer) is removed.
 *
 * 7-day soft-delete cooling-off (PRD-W AC-15). Audit trail in
 * `agent_training_events` (event_type='right_to_forget_*').
 *
 * Behind feature flag `FEATURE_LOOP_RIGHT_TO_FORGET` (default false).
 *
 * SOLID: SRP — RTF lifecycle only. Move PTB build + sponsor signing live
 * in `routes/v3-loop.ts`. This service exposes `getStalePending()` so the
 * cron is the only place that knows the 7-day window — keeps tests cheap.
 */

import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { ScheduledCron } from './personaAutoRewrite';
import { perBuyerNamespace } from './memoryService';

export interface RtfDeps {
  pool: Pool;
  logger: Logger;
  /** Called by cron after Sui PTB succeeds — purges Postgres mirror. */
  purgeNamespaces?: (namespaces: string[]) => Promise<void>;
  enabled: () => boolean;
}

export interface RtfRequest {
  id: number;
  agent_id: string;
  buyer_addr: string;
  status: 'pending' | 'cancelled' | 'executed';
  requested_at: string;
}

const COOLING_OFF_DAYS = 7;

export class RightToForgetService implements ScheduledCron {
  readonly name = 'rightToForget';
  readonly utc_minute = 5 * 60; // 0500 UTC

  constructor(private readonly deps: RtfDeps) {}

  // ─── Service methods (called by routes) ─────────────────────────

  async request(args: { agent_id: string; buyer_addr: string; reason?: string }): Promise<RtfRequest> {
    const r = await this.deps.pool.query<RtfRequest>(
      `INSERT INTO right_to_forget_requests (agent_id, buyer_addr, reason, status)
            VALUES ($1, $2, $3, 'pending')
       RETURNING id, agent_id, buyer_addr, status, requested_at`,
      [args.agent_id, args.buyer_addr, args.reason ?? null],
    );
    return r.rows[0];
  }

  async cancel(args: { request_id: number; buyer_addr: string }): Promise<boolean> {
    const r = await this.deps.pool.query(
      `UPDATE right_to_forget_requests
          SET status = 'cancelled', cancelled_at = now()
        WHERE id = $1 AND buyer_addr = $2 AND status = 'pending'`,
      [args.request_id, args.buyer_addr],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async listPendingForBuyer(buyer_addr: string): Promise<RtfRequest[]> {
    const r = await this.deps.pool.query<RtfRequest>(
      `SELECT id, agent_id, buyer_addr, status, requested_at
         FROM right_to_forget_requests
        WHERE buyer_addr = $1 AND status = 'pending'
        ORDER BY requested_at DESC`,
      [buyer_addr],
    );
    return r.rows;
  }

  // ─── Cron tick ──────────────────────────────────────────────────

  async tick(_now: Date): Promise<void> {
    if (!this.deps.enabled()) return;

    const stale = await this.deps.pool.query<RtfRequest>(
      `SELECT id, agent_id, buyer_addr, status, requested_at
         FROM right_to_forget_requests
        WHERE status = 'pending'
          AND requested_at < now() - INTERVAL '${COOLING_OFF_DAYS} days'
        ORDER BY requested_at ASC LIMIT 50`,
    );

    for (const req of stale.rows) {
      try {
        await this.executeOne(req);
      } catch (e) {
        this.deps.logger.error(
          { err: (e as Error).message, request_id: req.id },
          'rtfCron:request_failed_continue',
        );
      }
    }

    if (stale.rowCount && stale.rowCount > 0) {
      this.deps.logger.info({ executed: stale.rowCount }, 'rtfCron:done');
    }
  }

  /** Atomic per-buyer-slot delete. General brain (cog-l4-{agent}) UNTOUCHED. */
  private async executeOne(req: RtfRequest): Promise<void> {
    const ns_l4 = perBuyerNamespace(4, req.agent_id, req.buyer_addr);
    const ns_l5 = perBuyerNamespace(5, req.agent_id, req.buyer_addr);

    // 1. Postgres mirror delete (idempotent).
    await this.deps.pool.query(
      `DELETE FROM cognitive_memories WHERE namespace IN ($1, $2)`,
      [ns_l4, ns_l5],
    );

    // 2. MemWal namespace purge (delegated). Sui Move entry
    //    `delete_per_buyer_memory<T>` is called by the route handler /
    //    cron driver since it needs sponsor signing.
    if (this.deps.purgeNamespaces) {
      await this.deps.purgeNamespaces([ns_l4, ns_l5]);
    }

    // 3. Mark executed.
    await this.deps.pool.query(
      `UPDATE right_to_forget_requests
          SET status = 'executed', executed_at = now()
        WHERE id = $1`,
      [req.id],
    );
  }
}
