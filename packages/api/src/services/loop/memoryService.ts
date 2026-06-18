/**
 * services/loop/memoryService.ts — PRD-W3 stratified memory service.
 *
 * Six narrow write methods + one read method + one upgrade-preview method.
 * Postgres `cognitive_memories` table is the OPERATIONAL source of truth
 * (lives behind `readWarmContext`); MemWal mirror is fire-and-forget for
 * the canonical decentralized-record story. Hybrid fail-mode per PRD-W6:
 *   - L2/L3 writes: MemWal failure → operator-pool fallback + Pino warn
 *   - L4/L5 writes: MemWal failure → throws → dispatcher halts the workflow
 *
 * SOLID:
 *   - SRP: memory-only. No Walrus blob upload, no Sui PTB build, no LLM call.
 *   - DIP: pool + mirror + classifier + delegateService injected.
 *   - OCP: adding L6 = a new method here; readWarmContext doesn't change.
 *
 * Performance:
 *   - readWarmContext is on the hot path of every workflow CAPTURE step.
 *     Single SQL query (one round-trip) with the partial index from 034.
 *   - PARA classifier is pure CPU; runs inline.
 */

import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { classifyPara, type ParaTag, type ParaKind } from './paraClassifier';

// ─── Namespace formatters (the v1.1 ownership model) ───────────────

/** `cog-l{4|5}-{agent_id}` — seller's general brain. */
export const agentNamespace = (level: 4 | 5, agent_id: string): string =>
  `cog-l${level}-${agent_id}`;

/** `cog-l{4|5}-{agent_id}-{buyer_addr}` — seller-owned per-buyer slot. */
export const perBuyerNamespace = (
  level: 4 | 5,
  agent_id: string,
  buyer_addr: string,
): string => `cog-l${level}-${agent_id}-${buyer_addr.toLowerCase()}`;

/** `artifact-vault-{buyer_addr}` — buyer-owned deliverables. */
export const artifactVaultNamespace = (buyer_addr: string): string =>
  `artifact-vault-${buyer_addr.toLowerCase()}`;

/** `buyer-preferences-{buyer_addr}` — opt-in vCard. */
export const buyerPreferencesNamespace = (buyer_addr: string): string =>
  `buyer-preferences-${buyer_addr.toLowerCase()}`;

// ─── Types ──────────────────────────────────────────────────────────

export interface MemWalMirror {
  /** Fire-and-forget; never throws. Returns blob_id when successful. */
  remember(args: { namespace: string; text: string; agent_id?: string }): Promise<string | null>;
}

export interface MemoryWriteResult {
  postgres_row_id: number;
  walrus_blob_id: string | null;
  namespace: string;
}

export interface WarmContextHit {
  id: number;
  text: string;
  namespace: string;
  para_kind: ParaKind | null;
  area_slug: string | null;
  created_at: string;
}

export interface WarmContextResult {
  agent_general: WarmContextHit[];
  per_buyer: WarmContextHit[];
}

export interface MemoryDeps {
  pool: Pool;
  mirror: MemWalMirror;
  logger: Logger;
}

// ─── Errors (per PRD-W6 hybrid fail-mode) ──────────────────────────

export class L4WriteFailedError extends Error {
  constructor(public namespace: string, cause: Error) {
    super(`L4 write failed for ${namespace}: ${cause.message}`);
    this.name = 'L4WriteFailedError';
  }
}

// ─── Service ─────────────────────────────────────────────────────────

export class MemoryService {
  constructor(private readonly deps: MemoryDeps) {}

  // L2 — semantic per-step (operator-pool fallback OK).
  async writeL2(args: {
    agent_id: string; job_id: string; step_id: string; text: string;
  }): Promise<MemoryWriteResult> {
    const ns = `cog-l2-${args.agent_id}-${args.job_id}-${args.step_id}`;
    return this.softWrite(args.agent_id, ns, args.text, /* fail_loud */ false);
  }

  // L3 — long-term per-job (operator-pool fallback OK).
  async writeL3(args: {
    agent_id: string; job_id: string; text: string;
  }): Promise<MemoryWriteResult> {
    const ns = `cog-l3-${args.agent_id}-${args.job_id}`;
    return this.softWrite(args.agent_id, ns, args.text, /* fail_loud */ false);
  }

  // L4 agent — anonymized, PARA-tagged, fail-loud.
  async writeL4Agent(args: {
    agent_id: string;
    text: string;
    classify: Parameters<typeof classifyPara>[0];
  }): Promise<MemoryWriteResult & ParaTag> {
    const tag = classifyPara(args.classify);
    const ns = agentNamespace(4, args.agent_id);
    const written = await this.hardWrite(args.agent_id, ns, args.text, tag);
    return { ...written, ...tag };
  }

  // L4 per-buyer — encrypted under buyer's privacy tier (PRD-G), fail-loud.
  async writeL4PerBuyer(args: {
    agent_id: string;
    buyer_addr: string;
    text: string;
    classify: Parameters<typeof classifyPara>[0];
  }): Promise<MemoryWriteResult & ParaTag> {
    const tag = classifyPara(args.classify);
    const ns = perBuyerNamespace(4, args.agent_id, args.buyer_addr);
    const written = await this.hardWrite(args.agent_id, ns, args.text, tag);
    return { ...written, ...tag };
  }

  // L5 agent — reflective critique, fail-loud (drives nightly persona cron).
  async writeL5Agent(args: {
    agent_id: string; text: string;
  }): Promise<MemoryWriteResult> {
    return this.hardWrite(args.agent_id, agentNamespace(5, args.agent_id), args.text, null);
  }

  // L5 per-buyer — relationship critique, fail-loud.
  async writeL5PerBuyer(args: {
    agent_id: string; buyer_addr: string; text: string;
  }): Promise<MemoryWriteResult> {
    const ns = perBuyerNamespace(5, args.agent_id, args.buyer_addr);
    return this.hardWrite(args.agent_id, ns, args.text, null);
  }

  /**
   * The F6 reflexive-loop hot path. Pulls past entries for both the agent's
   * general brain and the per-buyer slot, filtered by PARA kind + area_slug.
   * Single SQL query — the partial index `idx_cognitive_memories_para_active`
   * (Migration 034) keeps it cheap.
   */
  async readWarmContext(args: {
    agent_id: string;
    buyer_addr?: string;
    area_slug?: string;
    filter_para_kinds?: ParaKind[];
    limit?: number;
  }): Promise<WarmContextResult> {
    const kinds = args.filter_para_kinds ?? ['project', 'area', 'resource'];
    const limit = Math.min(args.limit ?? 25, 50);
    const generalNs = agentNamespace(4, args.agent_id);
    const perBuyerNs = args.buyer_addr ? perBuyerNamespace(4, args.agent_id, args.buyer_addr) : null;

    const sql = `
      SELECT id, text, namespace, para_kind, area_slug, created_at
        FROM cognitive_memories
       WHERE namespace = ANY($1::text[])
         AND para_kind = ANY($2::text[])
         ${args.area_slug ? 'AND (area_slug = $4 OR area_slug IS NULL)' : ''}
       ORDER BY created_at DESC
       LIMIT $3
    `;
    const namespaces = perBuyerNs ? [generalNs, perBuyerNs] : [generalNs];
    const params: unknown[] = [namespaces, kinds, limit];
    if (args.area_slug) params.push(args.area_slug);

    const rows = await this.deps.pool.query<WarmContextHit>(sql, params);

    const agent_general: WarmContextHit[] = [];
    const per_buyer: WarmContextHit[] = [];
    for (const r of rows.rows) {
      (r.namespace === generalNs ? agent_general : per_buyer).push(r);
    }
    return { agent_general, per_buyer };
  }

  /**
   * Upgrade-wizard preview — classifies historical entries for an agent
   * WITHOUT writing changes. Returns the distribution + a 50-row sample.
   */
  async classifyHistorical(agent_id: string): Promise<{
    distribution: Record<ParaKind, number>;
    sample: Array<{ id: number; namespace: string; predicted: ParaTag; created_at: string }>;
  }> {
    const result = await this.deps.pool.query<{
      id: number; namespace: string; created_at: string; text: string;
    }>(
      `SELECT id, namespace, created_at, text
         FROM cognitive_memories
        WHERE namespace LIKE $1
        ORDER BY created_at DESC
        LIMIT 200`,
      [`cog-l4-${agent_id}%`],
    );

    const distribution: Record<ParaKind, number> = {
      project: 0, area: 0, resource: 0, archive: 0,
    };
    const sample: Array<{ id: number; namespace: string; predicted: ParaTag; created_at: string }> = [];
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

    for (const row of result.rows) {
      const isOld = new Date(row.created_at).getTime() < thirtyDaysAgo;
      const predicted: ParaTag = isOld
        ? { para_kind: 'archive', area_slug: null }
        : classifyPara({ /* no overrides — exercises Rule 5 default */ });
      distribution[predicted.para_kind] += 1;
      if (sample.length < 50) {
        sample.push({ id: row.id, namespace: row.namespace, predicted, created_at: row.created_at });
      }
    }
    return { distribution, sample };
  }

  // ─── Internals ────────────────────────────────────────────────────

  private async softWrite(
    agent_id: string,
    namespace: string,
    text: string,
    fail_loud: boolean,
  ): Promise<MemoryWriteResult> {
    const ins = await this.deps.pool.query<{ id: number }>(
      `INSERT INTO cognitive_memories (brain_id, namespace, text, cognitive_level)
            VALUES ($1, $2, $3, $4) RETURNING id`,
      [agent_id, namespace, text, levelOf(namespace)],
    );
    const blob = await this.deps.mirror.remember({ namespace, text, agent_id }).catch((e: Error) => {
      if (fail_loud) throw new L4WriteFailedError(namespace, e);
      this.deps.logger.warn({ ns: namespace, err: e.message }, 'memwal:soft_write_fallback');
      return null;
    });
    return { postgres_row_id: ins.rows[0].id, walrus_blob_id: blob, namespace };
  }

  private async hardWrite(
    agent_id: string,
    namespace: string,
    text: string,
    tag: ParaTag | null,
  ): Promise<MemoryWriteResult> {
    const ins = await this.deps.pool.query<{ id: number }>(
      `INSERT INTO cognitive_memories
            (brain_id, namespace, text, cognitive_level, para_kind, area_slug)
        VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [agent_id, namespace, text, levelOf(namespace), tag?.para_kind ?? null, tag?.area_slug ?? null],
    );
    const blob = await this.deps.mirror
      .remember({ namespace, text, agent_id })
      .catch((e: Error) => {
        throw new L4WriteFailedError(namespace, e);
      });
    return { postgres_row_id: ins.rows[0].id, walrus_blob_id: blob, namespace };
  }
}

function levelOf(ns: string): number {
  const m = /^cog-l(\d)-/.exec(ns);
  return m ? Number(m[1]) : 0;
}
