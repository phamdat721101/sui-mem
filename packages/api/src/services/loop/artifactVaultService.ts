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
}
