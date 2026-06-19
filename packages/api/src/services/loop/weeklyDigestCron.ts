/**
 * services/loop/weeklyDigestCron.ts — Sunday 0500 UTC weekly digest cron.
 *
 * For each buyer with ≥3 runs in the last 7 days, synthesizes a markdown
 * digest via the Phala TEE inference client (consistent with the rest of
 * the codebase — no Bedrock dependency) and deposits it as a vault entry
 * with `area_slug = 'digest'` and `job_id = digest-{ISOWeek}`. Idempotent:
 * a second tick within the same week is a no-op for already-digested
 * buyers.
 *
 * Privacy invariant: the synthesizer reads only run METADATA (date, area,
 * status, cost, artifact count, artifact names). It NEVER reads artifact
 * contents — Tier 4 E2EE is preserved end-to-end.
 *
 * SOLID:
 *   - SRP: scan + synthesize + deposit. No HTTP, no on-chain ops.
 *   - DIP: pool, walrus, vault, llm, mirror, logger — all injected.
 *   - LSP: implements `ScheduledCron` (utc_minute + tick(now)). The runner
 *     in server.ts can swap in any cron with no other change.
 */

import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { ScheduledCron } from './personaAutoRewrite';
import { ArtifactVaultService } from './artifactVaultService';

/** A minimal LLM contract — implemented by Phala client adapter below. */
export interface DigestLLM {
  infer(messages: Array<{ role: 'system' | 'user'; content: string }>): Promise<{ answer: string }>;
}

export interface WalrusUploader {
  upload(bytes: Uint8Array): Promise<{ blobs: Array<{ blobId: string }> }>;
}

export interface WeeklyDigestDeps {
  pool: Pool;
  vault: ArtifactVaultService;
  walrus: WalrusUploader;
  llm: DigestLLM;
  logger: Logger;
  enabled: () => boolean;
}

const MIN_RUNS = 3;          // Skip buyers with fewer runs — not enough signal.
const DIGEST_AREA = 'digest';

const DIGEST_SYSTEM_PROMPT = `You are a weekly digest synthesizer. Given a JSON
payload describing a buyer's last 7 days of agent runs, produce a 1-page
markdown report with these sections (in order):

# Week summary
A 2-3 sentence outcome-oriented summary.

## Runs
A markdown table: | Date | Area | Status | Cost | Artifacts |

## Key findings
Bullet list of patterns visible from the run metadata. NO artifact contents
are available; reason from area_slug, run_status, durations, artifact names.

## Trends across runs
Bullet list of trends across the 7 days.

## Suggested next areas
3-5 short bullets recommending next areas/topics to run.

Keep total length under 600 words. Markdown only — no code fences around
the whole thing.`;

export class WeeklyDigestCron implements ScheduledCron {
  readonly name = 'weeklyDigest';
  readonly utc_minute = 5 * 60; // 0500 UTC

  constructor(private readonly deps: WeeklyDigestDeps) {}

  async tick(now: Date): Promise<void> {
    if (!this.deps.enabled()) return;
    if (now.getUTCDay() !== 0) return; // Sunday only

    const week = isoWeekKey(now);

    // 1. Find buyers with ≥3 runs in the last 7 days.
    const buyers = await this.deps.pool.query<{ buyer_addr: string; n: number }>(
      `SELECT buyer_addr, COUNT(*)::int AS n
         FROM workflow_runs
        WHERE started_at > now() - INTERVAL '7 days'
        GROUP BY buyer_addr
       HAVING COUNT(*) >= $1`,
      [MIN_RUNS],
    );

    let synthesized = 0;
    let skipped = 0;

    for (const b of buyers.rows) {
      try {
        if (await this.digestExists(b.buyer_addr, week)) {
          skipped += 1;
          continue;
        }
        const { runs } = await this.deps.vault.listByRun(b.buyer_addr, { sinceDays: 7, limit: 50 });
        if (runs.length < MIN_RUNS) {
          skipped += 1;
          continue;
        }
        const markdown = await this.synthesize(b.buyer_addr, week, runs);
        const bytes = new TextEncoder().encode(markdown);
        const upload = await this.deps.walrus.upload(bytes);
        const walrus_blob_id = upload.blobs[0]?.blobId;
        if (!walrus_blob_id) {
          this.deps.logger.warn({ buyer: b.buyer_addr }, 'digestCron:walrus_no_blob');
          continue;
        }
        await this.deps.vault.deposit({
          buyer_addr: b.buyer_addr,
          area_slug: DIGEST_AREA,
          job_id: `digest-${week}`,
          artifacts: [{
            name: `digest-${week}.md`,
            walrus_blob_id,
            mime_type: 'text/markdown',
            size_bytes: bytes.length,
          }],
        });
        synthesized += 1;
      } catch (e) {
        this.deps.logger.error(
          { err: (e as Error).message, buyer: b.buyer_addr, week },
          'digestCron:buyer_failed_continue',
        );
      }
    }

    if (synthesized || skipped) {
      this.deps.logger.info({ synthesized, skipped, week }, 'digestCron:done');
    }
  }

  private async digestExists(buyer_addr: string, week: string): Promise<boolean> {
    const r = await this.deps.pool.query(
      `SELECT 1 FROM cognitive_memories
        WHERE namespace = $1
          AND area_slug = 'digest'
          AND text::jsonb ->> 'job_id' = $2
        LIMIT 1`,
      [`artifact-vault-${buyer_addr.toLowerCase()}`, `digest-${week}`],
    );
    return Boolean(r.rowCount);
  }

  private async synthesize(
    buyer_addr: string,
    week: string,
    runs: Awaited<ReturnType<ArtifactVaultService['listByRun']>>['runs'],
  ): Promise<string> {
    const payload = {
      buyer: buyer_addr,
      week,
      runs: runs.map((r) => ({
        date: r.run_started_at,
        area: r.area_slug,
        status: r.run_status,
        cost_micro: r.total_cost_micro,
        step_count: r.step_count,
        artifact_count: r.artifacts.length,
        artifact_names: r.artifacts.map((a) => a.artifact_name).slice(0, 8),
      })),
    };
    const result = await this.deps.llm.infer([
      { role: 'system', content: DIGEST_SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(payload) },
    ]);
    return result.answer;
  }
}

/** ISO week key like "2026-W26". Sunday-anchored: Sun→Sat is one ISO week. */
export function isoWeekKey(now: Date): string {
  // Use the canonical ISO 8601 week-numbering algorithm.
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = d.getUTCDay() || 7; // Sun = 7
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}
