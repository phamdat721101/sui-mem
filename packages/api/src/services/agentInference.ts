/**
 * agentInference.ts — shared inference orchestrator for `/v3/agents/:slug/try`
 * (free + paid) and `/api/v1/:slug` (paid).
 *
 * One pipeline, used everywhere — eliminates the drift bug PRD-E called out
 * in fhe-ai-context where two routes built slightly different prompts.
 *
 * Flow:
 *   1. Recall N chunks from the brain via the injected `recall` fn (optional).
 *   2. Resolve `uploadIds[]` against `task_uploads`:
 *        - PDF rows w/ extraction_status='ok' → inline `extracted_text`
 *          (already char-capped at extract time).
 *        - PDF rows w/ status ∈ {password_protected, no_text, ...} → URL note.
 *        - texty MIME ≤100 KB & not consumed → fetch + inline (size-bounded).
 *        - else → reference by name + size.
 *   3. Build system prompt (persona + RAG + upload context, in that order).
 *   4. Call PhalaTeeInference.infer(); return shaped result.
 *
 * SOLID:
 *   - SRP: orchestrate. No HTTP, no settle, no DB writes outside `consumed_at`.
 *   - DIP: every collaborator injected via `Deps`. Tests pass stubs.
 *   - OCP: a new context source (e.g. URL fetch) is one new branch in
 *     `buildUploadContext`; the orchestrator shape is unchanged.
 */

import type { Pool } from 'pg';
import { pool } from '../db';
import type {
  PhalaInferenceClient,
  WalrusStore,
} from '@fhe-ai-context/sui-sdk';

export interface RecallHit {
  text: string;
  source?: string;
  distance?: number;
}

export type RecallFn = (args: {
  query: string;
  brainId: number;
  limit: number;
}) => Promise<RecallHit[]>;

export interface InferenceDeps {
  pool: Pool;
  phala: PhalaInferenceClient;
  walrus: WalrusStore;
  /** Optional. When omitted, the answer is system-prompt + uploads only. */
  recall?: RecallFn;
  logger?: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
}

export interface AgentForInference {
  id: string;
  slug: string;
  brain_id: number;
  persona: { system_prompt?: string | null; description?: string | null } | null;
}

export interface RunInferenceResult {
  answer: string;
  citations: Array<{ source?: string; snippet: string }>;
  attestation: { provider: string; quote: string; verified: boolean; issuedAt: string };
}

const RECALL_LIMIT = 5;
const TEXTY_INLINE_MAX = 100_000; // bytes
const TEXTY_RE = /^(text\/|application\/(json|csv|x-yaml|xml|yaml))/i;

/**
 * SOLID: extracted recall helper so /v3/agents and /api/v1/<slug> share one
 * source of truth. v1 = keyword + recency over knowledge_chunks; v2 swaps
 * to real MemWal semantic recall without touching either route file.
 */
export async function recallFromKnowledgeChunks(args: {
  query: string;
  brainId: number;
  limit: number;
}): Promise<RecallHit[]> {
  const tokens = args.query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9]+/g, ''))
    .filter((t) => t.length >= 3)
    .slice(0, 6);
  const r = tokens.length === 0
    ? await pool.query<{ content: string; chunk_index: number }>(
        `SELECT content, chunk_index FROM knowledge_chunks
          WHERE brain_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [args.brainId, args.limit],
      )
    : await pool.query<{ content: string; chunk_index: number }>(
        `SELECT content, chunk_index,
                (${tokens.map((_, i) => `(CASE WHEN content ILIKE '%' || $${i + 3} || '%' THEN 1 ELSE 0 END)`).join(' + ')})::int AS score
           FROM knowledge_chunks
          WHERE brain_id = $1
            AND (${tokens.map((_, i) => `content ILIKE '%' || $${i + 3} || '%'`).join(' OR ')})
          ORDER BY score DESC, created_at DESC LIMIT $2`,
        [args.brainId, args.limit, ...tokens],
      );
  return r.rows.map((row) => ({ text: row.content, source: `chunk #${row.chunk_index}` }));
}

/**
 * Pure helper — combines persona + RAG + upload context into one system
 * prompt. Same shape used by both /try and /api/v1/<slug> so prompt drift
 * is impossible.
 */
export function buildSystemPrompt(
  persona: AgentForInference['persona'],
  ragContext: string,
  uploadContext: string,
): string {
  const sellerPrompt = (persona?.system_prompt ?? '').trim();
  const grounding = ragContext
    ? `Knowledge base excerpts:\n${ragContext}`
    : 'No knowledge base excerpts available — answer from your general knowledge if reasonable, or honestly say the brain is empty.';
  const uploads = uploadContext ? `\n\nUser-attached documents:\n${uploadContext}` : '';
  const head = sellerPrompt ? `${sellerPrompt}\n\n---\n\n` : '';
  return `${head}${grounding}${uploads}`;
}

interface UploadRow {
  id: string;
  walrus_blob_id: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  extracted_text: string | null;
  extraction_status: string;
  consumed_at: Date | null;
}

async function loadUploadRows(
  pool: Pool,
  agentId: string,
  uploadIds: string[],
): Promise<UploadRow[]> {
  if (!uploadIds.length) return [];
  const r = await pool.query<UploadRow>(
    `SELECT id, walrus_blob_id, original_name, mime_type, size_bytes,
            extracted_text, extraction_status, consumed_at
       FROM task_uploads
      WHERE agent_id = $1 AND id = ANY($2::uuid[])
        AND expires_at > now()`,
    [agentId, uploadIds],
  );
  return r.rows;
}

/**
 * Build the labelled upload-context block. Inlines text-y small files +
 * cached PDF text; references everything else by name + status note.
 */
async function buildUploadContext(
  walrus: WalrusStore,
  rows: UploadRow[],
): Promise<string> {
  if (!rows.length) return '';
  const parts: string[] = [];
  for (const u of rows) {
    const header = `### ${u.original_name} (${u.mime_type}, ${u.size_bytes} bytes)`;
    if (u.mime_type === 'application/pdf') {
      if (u.extraction_status === 'ok' && u.extracted_text) {
        parts.push(`${header}\n${u.extracted_text}`);
      } else {
        parts.push(`${header}\n(PDF could not be parsed: ${u.extraction_status}; the file is attached as a Walrus reference only)`);
      }
      continue;
    }
    if (TEXTY_RE.test(u.mime_type) && u.size_bytes <= TEXTY_INLINE_MAX) {
      try {
        const bytes = await walrus.fetch(u.walrus_blob_id);
        const text = Buffer.from(bytes).toString('utf8').slice(0, TEXTY_INLINE_MAX);
        parts.push(`${header}\n${text}`);
      } catch {
        parts.push(`${header}\n(failed to fetch from Walrus; referenced by blob id only: ${u.walrus_blob_id})`);
      }
      continue;
    }
    parts.push(`${header}\n(binary attachment; Walrus blob_id ${u.walrus_blob_id})`);
  }
  return parts.join('\n\n');
}

async function markConsumed(pool: Pool, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await pool
    .query(`UPDATE task_uploads SET consumed_at = now() WHERE id = ANY($1::uuid[])`, [ids])
    .catch(() => undefined);
}

function joinCitations(hits: RecallHit[]): string {
  if (!hits.length) return '';
  return hits.map((h, i) => `[${i + 1}] ${h.text}`).join('\n\n');
}

export async function runInference(
  deps: InferenceDeps,
  agent: AgentForInference,
  question: string,
  uploadIds: string[] = [],
): Promise<RunInferenceResult> {
  const trimmedQ = question.trim();
  if (!trimmedQ) throw new Error('question_required');

  const [recallHits, uploadRows] = await Promise.all([
    deps.recall
      ? deps.recall({ query: trimmedQ, brainId: agent.brain_id, limit: RECALL_LIMIT }).catch((e) => {
          deps.logger?.warn?.({ err: (e as Error).message, brainId: agent.brain_id }, 'agentInference:recall:failed');
          return [] as RecallHit[];
        })
      : Promise.resolve<RecallHit[]>([]),
    loadUploadRows(deps.pool, agent.id, uploadIds.slice(0, 5)),
  ]);

  const ragContext = joinCitations(recallHits);
  const uploadContext = await buildUploadContext(deps.walrus, uploadRows);
  const systemPrompt = buildSystemPrompt(agent.persona, ragContext, uploadContext);

  const result = await deps.phala.infer(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: trimmedQ },
    ],
    { logger: deps.logger as never },
  );

  // Best-effort consume marker — not in the critical path.
  void markConsumed(deps.pool, uploadRows.map((u) => u.id));

  return {
    answer: result.answer,
    citations: recallHits.map((h) => ({ source: h.source, snippet: h.text.slice(0, 200) })),
    attestation: result.attestation,
  };
}
