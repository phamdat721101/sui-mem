/**
 * routes/v1Public.ts — public per-slug AI-buyer entry point.
 *
 * Mounted at `/api/v1` WITHOUT the global `auth` middleware: the paywall is
 * the auth. AI clients (Claude, Cursor, custom agents) call this surface
 * directly, get back a 402 with the Sui USDC payment requirements, settle,
 * and retry with `X-PAYMENT`.
 *
 *   GET  /:slug/.well-known/agent.json   AgentCard for auto-discovery
 *   POST /:slug                          paid inference (402 → 200)
 *
 * SOLID:
 *   - SRP: HTTP only. Inference + settle live in their own modules.
 *   - DIP: imports `agentX402Middleware` (paywall) and `runInference`
 *     (orchestration); knows nothing about Sui internals.
 *   - OCP: a future surface (e.g. WebSocket streaming) plugs into the
 *     same `agentX402Middleware` + `runInference` without touching the
 *     route shape. The provider cache is keyed by slug so cache eviction
 *     is one call: `invalidateProvider(slug)`.
 */

import { Router, type Request, type Response } from 'express';
import { logger } from '../lib';
import {
  agentX402Middleware,
  loadAgentBySlug,
  type AgentRow,
} from '../middleware/agentX402';
import { runInference, recallFromKnowledgeChunks, type InferenceDeps } from '../services/agentInference';
import { pool } from '../db';
import { createWalrusStore, createPhalaClient } from '@fhe-ai-context/sui-sdk';

const router = Router();

// ─── Inference deps singleton (shared with /v3/agents) ──────────────────

let _deps: InferenceDeps | null = null;
function getDeps(): InferenceDeps {
  if (_deps) return _deps;
  _deps = {
    pool,
    walrus: createWalrusStore(),
    phala: createPhalaClient(),
    logger,
    recall: recallFromKnowledgeChunks,
  };
  return _deps;
}

// ─── Provider cache (slug → AgentCard JSON), evictable on agent edit ────

interface AgentCard {
  name: string;
  description: string;
  url: string;
  payTo: string;
  chain: string;
  asset: string | null;
  tools: Array<{ name: string; description: string; price: string; currency: 'USDC' }>;
  system_prompt: string | null;
}

interface CacheEntry { agent: AgentRow; card: AgentCard; }
const cache = new Map<string, CacheEntry>();

function buildAgentCard(agent: AgentRow): AgentCard {
  const network = agent.chain ?? process.env.SUI_NETWORK ?? 'sui-testnet';
  const apiBase = process.env.PUBLIC_API_URL ?? 'http://localhost:3001';
  const price = agent.pricing?.sui_usdc ?? agent.pricing?.x402 ?? '0';
  return {
    name: agent.slug,
    description: agent.persona?.description ?? `OpenX agent "${agent.slug}" — pay-per-call USDC on ${network}`,
    url: `${apiBase}/api/v1/${agent.slug}`,
    payTo: agent.owner_address,
    chain: network,
    asset: process.env.OPENX_USDC_COIN_TYPE ?? null,
    tools: [{
      name: 'ask',
      description: 'Ask this agent a question. Optional uploadIds[] attach Walrus blobs as context.',
      price,
      currency: 'USDC',
    }],
    system_prompt: agent.persona?.system_prompt ?? null,
  };
}

async function getEntry(slug: string): Promise<CacheEntry | null> {
  const hit = cache.get(slug);
  if (hit) return hit;
  const agent = await loadAgentBySlug(slug);
  if (!agent) return null;
  const entry: CacheEntry = { agent, card: buildAgentCard(agent) };
  cache.set(slug, entry);
  return entry;
}

/** Force-evict on owner edit (call from /v3/marketplace PATCH paths). */
export function invalidateProvider(slug: string): void {
  cache.delete(slug);
}

// ─── Routes ─────────────────────────────────────────────────────────────

router.get('/:slug/.well-known/agent.json', async (req: Request, res: Response) => {
  const entry = await getEntry(String(req.params.slug));
  if (!entry) return res.status(404).json({ error: 'agent_not_found' });
  res.json(entry.card);
});

// POST /:slug — runs the paywall, then runInference. Caller body:
//   { question: string, uploadIds?: string[], buyer_address, payment_coin_object_id }
// Headers (after settle): X-PAYMENT, X-Buyer-Address.
router.post('/:slug', agentX402Middleware(), async (req: Request, res: Response) => {
  const slug = String(req.params.slug);
  const entry = await getEntry(slug);
  if (!entry) return res.status(404).json({ error: 'agent_not_found' });

  const body = (req.body ?? {}) as {
    question?: string; q?: string; message?: string; uploadIds?: string[]; upload_ids?: string[];
  };
  const question = String(body.question ?? body.q ?? body.message ?? '').trim();
  if (!question) return res.status(400).json({ error: 'question_required' });

  const uploadIds = (body.uploadIds ?? body.upload_ids ?? []).slice(0, 5);
  let result;
  try {
    result = await runInference(getDeps(), entry.agent, question, uploadIds);
  } catch (e) {
    logger.error({ err: (e as Error).message, slug }, 'v1Public:inference:failed');
    return res.status(502).json({ error: 'inference_failed', detail: (e as Error).message });
  }

  // Ledger row was already written by agentX402Middleware on settle. Reading
  // the digest off req.agentSettlement gives us the canonical envelope.
  const settled = req.agentSettlement;
  res.json({
    answer: result.answer,
    citations: result.citations,
    attestation: result.attestation,
    settled: settled
      ? {
          tx_digest: settled.txDigest,
          amount_micro_usdc: settled.amountMicro.toString(),
          network: process.env.SUI_NETWORK ?? 'sui-testnet',
        }
      : null,
  });
});

export default router;

// Re-export the type so /v3-marketplace PATCH handlers (a follow-up) can
// invalidate the cache without importing the full router module.
export type { AgentCard };
