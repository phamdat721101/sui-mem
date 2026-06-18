/**
 * services/loop/workflowScheduler.ts — daily-run subscription cron.
 *
 * THE NEW v1.1+ primitive on top of the locked PRD-W spec. Reads
 * `loop_subscriptions` for due rows, builds a `fork_run` PTB, lets the
 * sponsor sign + submit, then delegates execution to `WorkflowDispatcher`
 * via the same path as one-shot hires.
 *
 * Schedule: every minute. The cron itself fires at any minute; subscriptions
 * have their own `cron_utc_minute` checked against `now`. This keeps the
 * server's cron loop simple (one heartbeat) while letting buyers pick
 * any minute-of-day.
 *
 * Behind feature flag `FEATURE_LOOP_DAILY_RUN` (default false).
 *
 * SOLID:
 *   - SRP: schedule + fork. Inference + memory writes flow through the
 *     existing `WorkflowDispatcher` — no logic duplication.
 *   - DIP: Sui PTB builder + dispatcher injected (via `SubscriptionRunner`).
 *
 * Performance: O(N due subs) per tick; partial index `idx_loop_subscriptions_due`
 * ensures the SELECT is index-only.
 */

import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { ScheduledCron } from './personaAutoRewrite';

export interface DueSubscription {
  id: number;
  subscription_object_id: string;
  agent_id: string;
  buyer_addr: string;
  template_walrus_blob_id: string;
  area_slug: string | null;
  cron_utc_minute: number;
  runs_remaining: number;
  max_per_run_micro: number;
  next_run_ts: number;
}

export interface SubscriptionRunner {
  /**
   * Fork a fresh LoopJob<T> from the subscription template, run the workflow
   * end-to-end, settle on chain. Returns the new job_id on success, throws
   * on chain failure (cron will retry next tick).
   */
  forkAndRun(sub: DueSubscription): Promise<{ job_id: string }>;
}

export interface SchedulerDeps {
  pool: Pool;
  runner: SubscriptionRunner;
  logger: Logger;
  enabled: () => boolean;
}

const TICK_BATCH = 25;

export class WorkflowSchedulerCron implements ScheduledCron {
  readonly name = 'workflowScheduler';
  // utc_minute=0 means "every tick" — the runner above polls by `next_run_ts`.
  readonly utc_minute = 0;

  constructor(private readonly deps: SchedulerDeps) {}

  async tick(now: Date): Promise<void> {
    if (!this.deps.enabled()) return;

    const due = await this.deps.pool.query<DueSubscription>(
      `SELECT id, subscription_object_id, agent_id, buyer_addr,
              template_walrus_blob_id, area_slug, cron_utc_minute,
              runs_remaining, max_per_run_micro, next_run_ts
         FROM loop_subscriptions
        WHERE cancelled_at IS NULL
          AND runs_remaining > 0
          AND next_run_ts <= $1
        ORDER BY next_run_ts ASC
        LIMIT ${TICK_BATCH}`,
      [now.getTime()],
    );

    if (!due.rowCount) return;

    for (const sub of due.rows) {
      try {
        const { job_id } = await this.deps.runner.forkAndRun(sub);

        const next_ts = computeNextRun(now, sub.cron_utc_minute);
        await this.deps.pool.query(
          `UPDATE loop_subscriptions
              SET runs_remaining = runs_remaining - 1,
                  last_run_ts    = $1,
                  next_run_ts    = $2
            WHERE id = $3`,
          [now.getTime(), next_ts, sub.id],
        );

        this.deps.logger.info(
          { sub_id: sub.subscription_object_id, job_id, runs_left: sub.runs_remaining - 1 },
          'scheduler:run_complete',
        );
      } catch (e) {
        this.deps.logger.error(
          { sub_id: sub.subscription_object_id, err: (e as Error).message },
          'scheduler:run_failed_will_retry',
        );
        // Don't decrement; let next tick retry.
      }
    }
  }
}

/** Returns the next-run epoch-ms — same `cron_utc_minute` tomorrow. */
export function computeNextRun(now: Date, cron_utc_minute: number): number {
  const next = new Date(now);
  next.setUTCSeconds(0, 0);
  next.setUTCHours(Math.floor(cron_utc_minute / 60));
  next.setUTCMinutes(cron_utc_minute % 60);
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime();
}
