/**
 * services/loop/personaAutoRewrite.ts — PRD-W3 nightly persona-rewrite cron.
 *
 * Schedule: 0300 UTC. Threshold: ≥3 L5 reflections per agent in the last 24h.
 * Behavior: LLM synthesizes a proposed persona delta, Walrus-pin the proposed
 * blob, insert a row into `persona_rewrite_proposals` (status='pending'), and
 * surface to the seller's S4 modal. **Sellers must approve via PTB** before
 * the new persona becomes active — this cron NEVER auto-applies.
 *
 * Behind feature flag `FEATURE_LOOP_W3_PERSONA_AUTO_REWRITE` (default false).
 *
 * SOLID:
 *   - SRP: scan + propose only. Approval/rejection lives in route handlers.
 *   - DIP: deps injected (pool, llm, mirror, logger). Testable without Phala.
 */

import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { MemWalMirror } from './memoryService';

/**
 * Shared cron interface. Every nightly job in this folder implements it.
 * The cron runner in `server.ts` calls `tick(now)` on a single-threaded
 * setInterval. LSP keeps swap-in trivial.
 */
export interface ScheduledCron {
  readonly name: string;
  /** UTC minute-of-day when this cron should fire (0..1439). */
  readonly utc_minute: number;
  /** Idempotent — safe to re-call within the same minute. */
  tick(now: Date): Promise<void>;
}

export interface PersonaSynthesizer {
  /** Returns the proposed persona blob bytes + a 1-line reasoning summary. */
  synthesize(args: {
    agent_id: string;
    reflections: string[];
  }): Promise<{ blob: Uint8Array; reasoning: string }>;
}

export interface PersonaCronDeps {
  pool: Pool;
  llm: PersonaSynthesizer;
  mirror: MemWalMirror;
  logger: Logger;
  enabled: () => boolean;
}

const REFLECTION_THRESHOLD = 3;
const LOOKBACK_HOURS = 24;

export class PersonaAutoRewriteCron implements ScheduledCron {
  readonly name = 'personaAutoRewrite';
  readonly utc_minute = 3 * 60; // 0300 UTC

  constructor(private readonly deps: PersonaCronDeps) {}

  async tick(_now: Date): Promise<void> {
    if (!this.deps.enabled()) return;

    // Find agents with ≥3 L5 reflections in last 24h.
    const candidates = await this.deps.pool.query<{ agent_id: string; reflection_count: number }>(
      `
      SELECT brain_id AS agent_id, COUNT(*)::int AS reflection_count
        FROM cognitive_memories
       WHERE namespace LIKE 'cog-l5-%'
         AND created_at > now() - INTERVAL '${LOOKBACK_HOURS} hours'
         AND brain_id NOT IN (
           SELECT agent_id FROM persona_rewrite_proposals
            WHERE status = 'pending'
         )
       GROUP BY brain_id
      HAVING COUNT(*) >= ${REFLECTION_THRESHOLD}
      `,
    );

    for (const row of candidates.rows) {
      try {
        await this.proposeForAgent(row.agent_id, row.reflection_count);
      } catch (e) {
        this.deps.logger.error(
          { err: (e as Error).message, agent_id: row.agent_id },
          'personaCron:agent_failed_continue',
        );
      }
    }

    if (candidates.rowCount && candidates.rowCount > 0) {
      this.deps.logger.info({ proposed: candidates.rowCount }, 'personaCron:done');
    }
  }

  private async proposeForAgent(agent_id: string, reflection_count: number): Promise<void> {
    const reflections = await this.deps.pool.query<{ text: string }>(
      `SELECT text FROM cognitive_memories
        WHERE brain_id = $1 AND namespace LIKE 'cog-l5-%'
          AND created_at > now() - INTERVAL '${LOOKBACK_HOURS} hours'
        ORDER BY created_at DESC LIMIT 20`,
      [agent_id],
    );

    const { blob, reasoning } = await this.deps.llm.synthesize({
      agent_id,
      reflections: reflections.rows.map((r) => r.text),
    });

    const ns = `persona-proposed-${agent_id}`;
    const blob_id = await this.deps.mirror
      .remember({ namespace: ns, text: Buffer.from(blob).toString('utf8'), agent_id })
      .catch(() => null);

    await this.deps.pool.query(
      `INSERT INTO persona_rewrite_proposals
              (agent_id, proposed_blob_id, reasoning, reflection_count, status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      [agent_id, blob_id ?? '', reasoning, reflection_count],
    );
  }
}
