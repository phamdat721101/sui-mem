/**
 * services/loop/artifactVaultService.ts — PRD-W v1.1 buyer artifact vault.
 *
 * The buyer owns this namespace; the workflow runner is the only writer
 * (during settlement). Deliverables (report.md, diagram.mermaid, content
 * pieces) are deposited here so buyers retain them after the engagement
 * ends — even if the seller revokes their agent.
 *
 * SOLID: SRP — deposit + list only. Sui access control + Walrus blob
 * lookup happen outside (route handlers + the existing Walrus client).
 */

import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { MemWalMirror } from './memoryService';
import { artifactVaultNamespace } from './memoryService';

export interface VaultDeposit {
  buyer_addr: string;
  area_slug: string | null;
  job_id: string;
  artifacts: Array<{ name: string; walrus_blob_id: string; mime_type: string; size_bytes: number }>;
}

export interface VaultEntry {
  job_id: string;
  area_slug: string | null;
  artifact_name: string;
  walrus_blob_id: string;
  mime_type: string;
  created_at: string;
}

/** A single workflow run grouped with its artifacts — the timeline unit. */
export interface RunGroup {
  job_id: string;
  area_slug: string | null;
  agent_id: string | null;
  run_started_at: string | null;
  run_completed_at: string | null;
  outcome_satisfied: boolean | null;
  total_cost_micro: number | null;
  step_count: number | null;
  workflow_walrus_blob_id: string | null;
  run_status: 'pending' | 'running' | 'success' | 'failed' | 'completed';
  artifacts: VaultEntry[];
}

export interface ListByRunOpts {
  /** Window in days (default 30, max 365). */
  sinceDays?: number;
  /** Max runs returned (default 50, max 200). */
  limit?: number;
}

export interface VaultDeps {
  pool: Pool;
  mirror: MemWalMirror;
  logger: Logger;
}

export class ArtifactVaultService {
  constructor(private readonly deps: VaultDeps) {}

  async deposit(input: VaultDeposit): Promise<{ deposited: number; namespace: string }> {
    const namespace = artifactVaultNamespace(input.buyer_addr);

    // Mark each paid_call row's artifact_vault_namespace pointer (best-effort;
    // no-op when the join key doesn't match — the manifest still lands in
    // cognitive_memories so list() works).
    await this.deps.pool.query(
      `UPDATE paid_calls
          SET artifact_vault_namespace = $1
        WHERE network = 'sui' AND tx_hash = $2`,
      [namespace, input.job_id],
    ).catch(() => undefined);

    // Write one manifest row per deliverable + mirror to MemWal.
    let deposited = 0;
    for (const a of input.artifacts) {
      const manifest = JSON.stringify({
        job_id: input.job_id,
        area_slug: input.area_slug,
        artifact_name: a.name,
        walrus_blob_id: a.walrus_blob_id,
        mime_type: a.mime_type,
        size_bytes: a.size_bytes,
      });
      try {
        await this.deps.pool.query(
          `INSERT INTO cognitive_memories (brain_id, namespace, text, cognitive_level, area_slug)
                VALUES ($1, $2, $3, 4, $4)`,
          [input.buyer_addr, namespace, manifest, input.area_slug],
        );
        await this.deps.mirror.remember({ namespace, text: manifest }).catch(() => null);
        deposited += 1;
      } catch (e) {
        this.deps.logger.warn({ err: (e as Error).message, name: a.name }, 'vault:deposit_failed');
      }
    }
    return { deposited, namespace };
  }

  /**
   * List all deliverables for a buyer. Reads from cognitive_memories
   * where namespace matches the vault. Each row's text is a JSON manifest
   * (stringified VaultManifestEntry) — caller parses.
   */
  async list(buyer_addr: string): Promise<VaultEntry[]> {
    const namespace = artifactVaultNamespace(buyer_addr);
    const r = await this.deps.pool.query<{ id: number; text: string; created_at: string }>(
      `SELECT id, text, created_at
         FROM cognitive_memories
        WHERE namespace = $1
        ORDER BY created_at DESC LIMIT 200`,
      [namespace],
    );
    const out: VaultEntry[] = [];
    for (const row of r.rows) {
      try {
        const m = JSON.parse(row.text) as {
          job_id: string; area_slug: string | null; artifact_name: string;
          walrus_blob_id: string; mime_type: string;
        };
        out.push({
          job_id: m.job_id,
          area_slug: m.area_slug,
          artifact_name: m.artifact_name,
          walrus_blob_id: m.walrus_blob_id,
          mime_type: m.mime_type,
          created_at: row.created_at,
        });
      } catch {
        // skip malformed rows; they're audit data only
      }
    }
    return out;
  }

  /**
   * Group artifacts by run (`job_id`) sorted by run start DESC. Reads from
   * the `workflow_run_artifacts` view (migration 035) which left-joins the
   * vault manifests with `workflow_runs` for status + cost + step_count.
   *
   * One SQL query, in-memory grouping. Single round-trip.
   */
  async listByRun(buyer_addr: string, opts: ListByRunOpts = {}): Promise<{ runs: RunGroup[] }> {
    const namespace = artifactVaultNamespace(buyer_addr);
    const sinceDays = Math.max(1, Math.min(opts.sinceDays ?? 30, 365));
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));

    const r = await this.deps.pool.query<{
      job_id: string; area_slug: string | null; artifact_name: string;
      walrus_blob_id: string; mime_type: string; size_bytes: number;
      namespace: string; buyer_addr: string;
      artifact_created_at: string;
      run_started_at: string | null; run_completed_at: string | null;
      outcome_satisfied: boolean | null;
      total_cost_micro: string | null;  // bigint comes back as string
      step_count: number | null;
      workflow_walrus_blob_id: string | null;
      agent_id: string | null;
      run_status: RunGroup['run_status'];
    }>(
      `SELECT *
         FROM workflow_run_artifacts
        WHERE namespace = $1
          AND artifact_created_at > now() - ($2 || ' days')::interval
        ORDER BY artifact_created_at DESC`,
      [namespace, String(sinceDays)],
    );

    const grouped = new Map<string, RunGroup>();
    for (const row of r.rows) {
      const job_id = row.job_id;
      if (!job_id) continue;
      let g = grouped.get(job_id);
      if (!g) {
        g = {
          job_id,
          area_slug: row.area_slug,
          agent_id: row.agent_id,
          run_started_at: row.run_started_at,
          run_completed_at: row.run_completed_at,
          outcome_satisfied: row.outcome_satisfied,
          total_cost_micro: row.total_cost_micro != null ? Number(row.total_cost_micro) : null,
          step_count: row.step_count,
          workflow_walrus_blob_id: row.workflow_walrus_blob_id,
          run_status: row.run_status,
          artifacts: [],
        };
        grouped.set(job_id, g);
      }
      g.artifacts.push({
        job_id: row.job_id,
        area_slug: row.area_slug,
        artifact_name: row.artifact_name,
        walrus_blob_id: row.walrus_blob_id,
        mime_type: row.mime_type,
        created_at: row.artifact_created_at,
      });
    }

    return { runs: [...grouped.values()].slice(0, limit) };
  }
}
