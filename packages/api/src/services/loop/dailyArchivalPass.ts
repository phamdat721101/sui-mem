/**
 * services/loop/dailyArchivalPass.ts — PRD-W3 nightly PARA archival cron.
 *
 * Schedule: 0400 UTC (after personaAutoRewrite at 0300). One SQL UPDATE
 * re-tags L4 cognitive memory rows >30 days old + not currently tagged
 * 'archive' as `para_kind = 'archive'`. Idempotent (re-running is a no-op
 * because the WHERE clause excludes rows already 'archive').
 *
 * Behind feature flag `FEATURE_LOOP_W3_PARA_ARCHIVAL` (default false).
 *
 * SOLID: SRP — archival only. The cron interface comes from personaAutoRewrite.
 */

import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { ScheduledCron } from './personaAutoRewrite';

const STALE_DAYS = 30;

export interface ArchivalCronDeps {
  pool: Pool;
  logger: Logger;
  enabled: () => boolean;
}

export class DailyArchivalPassCron implements ScheduledCron {
  readonly name = 'dailyArchivalPass';
  readonly utc_minute = 4 * 60; // 0400 UTC

  constructor(private readonly deps: ArchivalCronDeps) {}

  async tick(_now: Date): Promise<void> {
    if (!this.deps.enabled()) return;

    const r = await this.deps.pool.query(
      `UPDATE cognitive_memories
          SET para_kind = 'archive'
        WHERE namespace LIKE 'cog-l4-%'
          AND created_at < now() - INTERVAL '${STALE_DAYS} days'
          AND (para_kind IS NULL OR para_kind != 'archive')`,
    );

    if (r.rowCount && r.rowCount > 0) {
      this.deps.logger.info({ archived: r.rowCount }, 'archivalCron:done');
    }
  }
}
