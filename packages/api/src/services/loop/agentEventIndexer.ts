/**
 * services/loop/agentEventIndexer.ts — Sui RPC event indexer cron.
 *
 * Polls `openx_loop_agent_registry` Move events (every minute, via the
 * existing inline cron loop in `server.ts`) and UPSERTs them into the
 * `agent_events` table (migration 037). Idempotent on `(tx_digest, seq_in_tx)`.
 *
 * Cursor state lives in the `agent_events_cursor` single-row table — the
 * indexer can crash mid-batch and re-poll safely because of the UNIQUE
 * constraint.
 *
 * SOLID:
 *   - SRP: poll + insert. No HTTP route, no aggregation, no event-shape
 *     decoding beyond pulling out the canonical fields downstream readers
 *     need (`agent_object_id`, `seller_addr`).
 *   - DIP: pool, suiClient, packageId, logger — all injected.
 *   - LSP: implements `ScheduledCron` (utc_minute=0 sentinel = every-minute).
 */

import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { SuiClient, EventId } from '@mysten/sui/client';
import type { ScheduledCron } from './personaAutoRewrite';

const PAGE_SIZE = 200;
const EVENT_MODULE = 'openx_loop_agent_registry';

export interface AgentEventIndexerDeps {
  pool: Pool;
  suiClient: SuiClient;
  packageId: () => string | undefined;
  logger: Logger;
  enabled: () => boolean;
}

export class AgentEventIndexerCron implements ScheduledCron {
  readonly name = 'agentEventIndexer';
  readonly utc_minute = 0; // sentinel: server.ts cron loop runs scheduler-class crons every minute

  constructor(private readonly deps: AgentEventIndexerDeps) {}

  async tick(_now: Date): Promise<void> {
    if (!this.deps.enabled()) return;
    const packageId = this.deps.packageId();
    if (!packageId) return; // package not deployed yet — safe no-op

    const cursor = await this.loadCursor();
    let totalIngested = 0;
    let nextCursor: EventId | null = cursor;
    let hasMore = true;

    // Bound the per-tick budget (max 5 pages) so a long backlog doesn't
    // hold the cron loop hostage. Subsequent ticks will catch up.
    for (let page = 0; page < 5 && hasMore; page++) {
      const result = await this.deps.suiClient.queryEvents({
        query: { MoveEventModule: { package: packageId, module: EVENT_MODULE } },
        cursor: nextCursor,
        limit: PAGE_SIZE,
        order: 'ascending',
      });
      if (!result.data.length) break;

      for (const ev of result.data) {
        try {
          await this.persist(ev);
          totalIngested += 1;
        } catch (e) {
          this.deps.logger.warn(
            { err: (e as Error).message, tx: ev.id?.txDigest, type: ev.type },
            'agentEventIndexer:persist_failed_continue',
          );
        }
      }
      nextCursor = result.nextCursor ?? nextCursor;
      hasMore = !!result.hasNextPage;
    }

    if (nextCursor) await this.saveCursor(nextCursor);
    if (totalIngested > 0) {
      this.deps.logger.info({ ingested: totalIngested }, 'agentEventIndexer:done');
    }
  }

  private async persist(ev: {
    id: EventId;
    type: string;
    parsedJson?: unknown;
    timestampMs?: string | null;
  }): Promise<void> {
    // Strip the `<package>::openx_loop_agent_registry::` prefix → short type.
    const shortType = ev.type.split('::').pop() ?? ev.type;
    const payload = (ev.parsedJson ?? {}) as Record<string, unknown>;

    // Pull canonical fields — most events have `id` (the agent object id)
    // and `seller`; registry-level events (BedrockModelWhitelisted/Delisted)
    // have neither and stay as registry-only rows.
    const agentObjectId =
      typeof payload.id === 'string' ? payload.id : null;
    const sellerAddr =
      typeof payload.seller === 'string' ? (payload.seller as string).toLowerCase() : null;
    const tsMs = ev.timestampMs ? Number(ev.timestampMs) : Date.now();

    await this.deps.pool.query(
      `INSERT INTO agent_events
            (agent_object_id, seller_addr, event_type, tx_digest, seq_in_tx,
             payload, timestamp_ms)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       ON CONFLICT (tx_digest, seq_in_tx) DO NOTHING`,
      [
        agentObjectId,
        sellerAddr,
        shortType,
        ev.id.txDigest,
        Number(ev.id.eventSeq ?? 0),
        JSON.stringify(payload),
        tsMs,
      ],
    );
  }

  private async loadCursor(): Promise<EventId | null> {
    const r = await this.deps.pool.query<{ cursor_json: { txDigest: string; eventSeq: string } | null }>(
      `SELECT cursor_json FROM agent_events_cursor WHERE id = 1`,
    );
    const c = r.rows[0]?.cursor_json;
    if (!c?.txDigest) return null;
    return { txDigest: c.txDigest, eventSeq: c.eventSeq ?? '0' };
  }

  private async saveCursor(cursor: EventId): Promise<void> {
    await this.deps.pool.query(
      `INSERT INTO agent_events_cursor (id, cursor_json, updated_at)
            VALUES (1, $1::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET
            cursor_json = EXCLUDED.cursor_json,
            updated_at  = now()`,
      [JSON.stringify(cursor)],
    );
  }
}
