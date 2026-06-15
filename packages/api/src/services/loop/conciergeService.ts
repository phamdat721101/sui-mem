/**
 * services/loop/conciergeService.ts — chat-driven loop discovery.
 *
 * Owns the three concerns the homepage chat box needs:
 *   1. `parseIntent(message)` — Phala-TEE-Bedrock-style JSON extraction.
 *   2. `deriveMode({ ... })` — heuristic returning 'x402' | 'loop'.
 *   3. `conciergeSearch({ ... })` — MemWal-backed ranked candidates with
 *      mode badges, plus best-effort persist of the query for the F6
 *      reflexive loop.
 *
 * SOLID:
 *   - SRP: discovery + mode derivation only. The PTB build / signing path
 *     lives in `routes/v3-loop.ts`.
 *   - DIP: MemWal adapter is constructed lazily via `createMemWalAdapter`;
 *     tests override.
 *
 * MemWal-first (Q5=b): the agent corpus lives entirely in the namespace
 * `openx-loop-agent-index`. Every published agent calls `indexLoopAgent`
 * (synchronously, after sponsored publish PTB succeeds).
 */

import { OpenXMemWalAdapter, type MemWalRecallHit as RecallHit } from '@fhe-ai-context/sdk';
import { createPhalaClient, type PhalaInferenceClient } from '@fhe-ai-context/sui-sdk';
import { logger } from '../../lib';

export const LOOP_AGENT_INDEX_NS = 'openx-loop-agent-index';
export const LOOP_CONCIERGE_NS = (wallet?: string) =>
  wallet ? `openx-loop-concierge-${wallet.toLowerCase().slice(0, 16)}` : 'openx-loop-concierge-anon';

// ─── Intent parsing ──────────────────────────────────────────────────────

export interface LoopIntent {
  capability: string;
  context_terms: string[];
  output_format?: 'pdf' | 'docx' | 'json' | 'text' | 'markdown';
  word_limit?: number;
  language_pair?: { source: string; target: string };
  needs_memory: boolean; // → forces mode='loop'
}

const FALLBACK_INTENT: LoopIntent = { capability: 'other', context_terms: [], needs_memory: false };

const INTENT_SYSTEM = `
You are an AI agent concierge. Given a buyer's free-text demand, return STRICT JSON:
{
  "capability": "translate|summarize|extract|audit|research|monitor|generate|classify|other",
  "context_terms": ["short keywords for ranking, lowercase"],
  "output_format": "pdf|docx|json|text|markdown",
  "word_limit": <int or null>,
  "language_pair": { "source": "en|vi|...", "target": "..." } | null,
  "needs_memory": <true if multi-step / persistent state required, else false>
}
Output ONLY the JSON. needs_memory=true ONLY for multi-iteration tasks.
`.trim();

export async function parseIntent(
  message: string,
  phala?: PhalaInferenceClient,
): Promise<LoopIntent> {
  if (!message || message.length > 1000) {
    return { ...FALLBACK_INTENT, context_terms: [message?.slice(0, 100) ?? ''] };
  }
  try {
    const llm = phala ?? createPhalaClient();
    const r = await llm.infer([
      { role: 'system', content: INTENT_SYSTEM },
      { role: 'user', content: message },
    ]);
    const trimmed = r.answer.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    const parsed = JSON.parse(trimmed) as Partial<LoopIntent>;
    return {
      capability: parsed.capability ?? 'other',
      context_terms: Array.isArray(parsed.context_terms) ? parsed.context_terms.slice(0, 10) : [],
      output_format: parsed.output_format,
      word_limit: typeof parsed.word_limit === 'number' ? parsed.word_limit : undefined,
      language_pair: parsed.language_pair,
      needs_memory: !!parsed.needs_memory,
    };
  } catch {
    // TF-IDF-friendly fallback: tokenize the raw message.
    return { ...FALLBACK_INTENT, context_terms: message.toLowerCase().split(/\s+/).slice(0, 10) };
  }
}

// ─── Mode derivation ─────────────────────────────────────────────────────

export function deriveMode(args: {
  fallbackMaxIterations?: number;
  tags?: string[] | null;
  intentNeedsMemory: boolean;
}): 'x402' | 'loop' {
  const tags = (args.tags ?? []).map((t) => t.toLowerCase());
  const requiresMemory = tags.includes('requires_memory') || args.intentNeedsMemory;
  const isOneShot = (args.fallbackMaxIterations ?? 1) === 1;
  return isOneShot && !requiresMemory ? 'x402' : 'loop';
}

// ─── MemWal-backed ranked search ─────────────────────────────────────────

export interface LoopCandidate {
  agent_object_id: string;
  seller: string;
  title: string;
  short_description: string;
  per_iter_default_micro_usdc: string;
  max_iter_per_job: number;
  tags: string[];
  mode: 'x402' | 'loop';
  score: number;
  reason: string;
}

export interface LoopAgentIndexRecord {
  agent_object_id: string;
  seller: string;
  title: string;
  short_description: string;
  persona_summary: string;
  tags: string[];
  per_iter_default_micro_usdc: string;
  max_iter_per_job: number;
  manifest_walrus_blob_id: string;
}

let _memwal: OpenXMemWalAdapter | null = null;
async function getMemwal(): Promise<OpenXMemWalAdapter | null> {
  if (process.env.MEMWAL_PEERDEP_ENABLED !== 'true') return null;
  if (_memwal) return _memwal;
  const accountId = process.env.OPENX_LOOP_MEMWAL_ACCOUNT_ID ?? process.env.OPENX_MEMWAL_ACCOUNT_ID;
  const delegateKeys = (process.env.OPENX_MEMWAL_DELEGATE_PRIVATE_KEYS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (!accountId || delegateKeys.length === 0) return null;
  _memwal = await OpenXMemWalAdapter.create({
    network: (process.env.MEMWAL_NETWORK ?? 'testnet') as 'mainnet' | 'testnet' | 'local',
    walletAddress: process.env.PLATFORM_WALLET ?? '0x0',
    accountId,
    delegateKeys,
    namespace: LOOP_AGENT_INDEX_NS,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });
  return _memwal;
}

/** Write an agent into the loop discovery index. Best-effort, never throws. */
export async function indexLoopAgent(rec: LoopAgentIndexRecord): Promise<void> {
  try {
    const mw = await getMemwal();
    if (!mw) return;
    const text = [
      rec.title,
      rec.short_description,
      rec.persona_summary.slice(0, 500),
      rec.tags.join(' '),
    ].filter(Boolean).join(' \n ');
    const payload = JSON.stringify({ ...rec, _ts: Date.now() });
    await mw.remember(`${text}\n---meta:${payload}`, LOOP_AGENT_INDEX_NS);
    logger.info({ agent_id: rec.agent_object_id }, 'loop:concierge:indexed');
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'loop:concierge:index_failed');
  }
}

function parseHit(h: RecallHit): LoopAgentIndexRecord | null {
  const m = h.text.match(/---meta:(\{.*\})/s);
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as LoopAgentIndexRecord;
  } catch {
    return null;
  }
}

export interface ConciergeSearchResult {
  intent: LoopIntent;
  candidates: LoopCandidate[];
  explain: string;
}

export async function conciergeSearch(args: {
  message: string;
  buyerAddress?: string;
  limit?: number;
}): Promise<ConciergeSearchResult> {
  const intent = await parseIntent(args.message);
  const query = [intent.capability, ...intent.context_terms].filter(Boolean).join(' ') || args.message;

  const mw = await getMemwal();
  let hits: RecallHit[] = [];
  if (mw) {
    try {
      const r = await mw.recall(query, { limit: args.limit ?? 5, namespace: LOOP_AGENT_INDEX_NS });
      hits = r.results;
    } catch (e) {
      logger.warn({ err: (e as Error).message }, 'loop:concierge:recall_failed');
    }
  }

  const candidates: LoopCandidate[] = [];
  for (const h of hits) {
    const meta = parseHit(h);
    if (!meta) continue;
    candidates.push({
      agent_object_id: meta.agent_object_id,
      seller: meta.seller,
      title: meta.title,
      short_description: meta.short_description,
      per_iter_default_micro_usdc: meta.per_iter_default_micro_usdc,
      max_iter_per_job: meta.max_iter_per_job,
      tags: meta.tags,
      mode: deriveMode({
        fallbackMaxIterations: meta.max_iter_per_job,
        tags: meta.tags,
        intentNeedsMemory: intent.needs_memory,
      }),
      score: 1 - h.distance,
      reason: `MemWal recall distance ${h.distance.toFixed(3)}`,
    });
  }

  // Best-effort persist for the F6 reflexive loop. Never blocks.
  if (mw && args.buyerAddress) {
    mw.remember(
      JSON.stringify({ q: args.message, intent, candidates, ts: Date.now() }),
      LOOP_CONCIERGE_NS(args.buyerAddress),
    ).catch(() => undefined);
  }

  return {
    intent,
    candidates,
    explain:
      candidates.length > 0
        ? `Matched ${candidates.length} loop agent(s) for capability=${intent.capability}.`
        : 'No loop agents matched. Try rephrasing or seed the index.',
  };
}
