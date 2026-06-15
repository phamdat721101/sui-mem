/**
 * routes/v3-agents.ts — buyer-facing workspace endpoints (PRD-E port).
 *
 * Mounted at `/v3/agents`. All routes are public — the paywall middleware
 * is the only auth on `/try` paid path; `/uploads/*` and `/recent-calls`
 * use lightweight in-memory rate limits.
 *
 * Routes:
 *   GET  /slug-available?slug=...              preflight for publish wizard
 *   POST /:slug/uploads/mint                   issue Walrus publisher URL + caps
 *   POST /:slug/uploads                        record blob_id; PDF → sync extract
 *   POST /:slug/try                            unified free (5/day) + paid /try
 *   GET  /:slug/recent-calls?limit=10          anonymized public ledger
 *
 * SOLID:
 *   - SRP: HTTP only. Inference lives in `agentInference.ts`; settle in
 *     `agentX402.ts`; PDF parse in `pdfExtractor.ts`; ledger in
 *     `paidCallLedger.ts`. This file is pure routing + validation.
 *   - DIP: pool, paymentGate-equivalent middleware, inference deps all
 *     resolved at module level via env (matching the rest of routes/).
 */

import { Router, type Request, type Response } from 'express';
import { pool } from '../db';
import { logger } from '../lib';
import { agentX402Middleware, loadAgentBySlug, type AgentRow } from '../middleware/agentX402';
import { getPdfExtractor } from '../services/pdfExtractor';
import { runInference, recallFromKnowledgeChunks, type InferenceDeps } from '../services/agentInference';
import * as ledger from '../services/paidCallLedger';
import { createWalrusStore, createPhalaClient } from '@fhe-ai-context/sui-sdk';

const router = Router();

// ─── Shared inference deps (lazy singleton) ─────────────────────────────

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

// ─── /slug-available — public preflight ─────────────────────────────────

const SLUG_RE = /^[a-z0-9-]{3,30}$/;
const RESERVED = new Set(['api', 'admin', 'health', 'metrics', 'well-known', 'platform']);

router.get('/slug-available', async (req: Request, res: Response) => {
  const slug = String(req.query.slug ?? '').trim().toLowerCase();
  if (!SLUG_RE.test(slug)) return res.json({ available: false, reason: 'invalid' });
  if (RESERVED.has(slug)) return res.json({ available: false, reason: 'reserved' });
  const r = await pool.query(`SELECT 1 FROM agents WHERE slug = $1`, [slug]);
  res.json({ available: (r.rowCount ?? 0) === 0 });
});

// ─── Upload mint + confirm ──────────────────────────────────────────────

const PDF_MAX_BYTES = 20_971_520;       // stricter than the 50 MB hard ceiling
const GENERIC_MAX_BYTES = 52_428_800;   // 50 MB
const MIME_WHITELIST = [
  /^text\//i,
  /^application\/(json|csv|x-yaml|yaml|xml|pdf|wasm|octet-stream)$/i,
  /^image\/(png|jpe?g|gif|webp)$/i,
];

function isAllowedMime(m: string): boolean {
  return MIME_WHITELIST.some((re) => re.test(m));
}

const WALRUS_PUBLISHER_URL =
  process.env.WALRUS_PUBLISHER_URL ?? 'https://publisher.walrus-testnet.walrus.space';
const WALRUS_AGGREGATOR_URL =
  process.env.WALRUS_AGGREGATOR_URL ?? 'https://aggregator.walrus-testnet.walrus.space';

// Per-agent in-memory cap: 100 mints/hour.
const mintBucket = new Map<string, { count: number; start: number }>();
function checkMintRate(agentId: string): boolean {
  const now = Date.now();
  const e = mintBucket.get(agentId);
  if (!e || now - e.start > 3_600_000) {
    mintBucket.set(agentId, { count: 1, start: now });
    return true;
  }
  if (e.count >= 100) return false;
  e.count += 1;
  return true;
}

router.post('/:slug/uploads/mint', async (req: Request, res: Response) => {
  const agent = await loadAgentBySlug(String(req.params.slug));
  if (!agent) return res.status(404).json({ error: 'agent_not_found' });

  const { original_name, mime_type, size_bytes } = (req.body ?? {}) as {
    original_name?: string; mime_type?: string; size_bytes?: number;
  };
  if (!original_name || !mime_type || typeof size_bytes !== 'number') {
    return res.status(400).json({ error: 'original_name, mime_type, size_bytes required' });
  }
  if (!isAllowedMime(mime_type)) return res.status(415).json({ error: 'mime_not_allowed' });
  const cap = mime_type === 'application/pdf' ? PDF_MAX_BYTES : GENERIC_MAX_BYTES;
  if (size_bytes <= 0 || size_bytes > cap) {
    return res.status(413).json({ error: 'too_large', max_bytes: cap });
  }
  if (!checkMintRate(agent.id)) return res.status(429).json({ error: 'mint_rate_limit' });

  res.json({
    publisher_url: WALRUS_PUBLISHER_URL,
    aggregator_url: WALRUS_AGGREGATOR_URL,
    max_bytes: cap,
    ttl_sec: 60,
  });
});

router.post('/:slug/uploads', async (req: Request, res: Response) => {
  const agent = await loadAgentBySlug(String(req.params.slug));
  if (!agent) return res.status(404).json({ error: 'agent_not_found' });

  const body = (req.body ?? {}) as {
    blob_id?: string; original_name?: string; mime_type?: string; size_bytes?: number;
    payer_address?: string;
  };
  const { blob_id, original_name, mime_type, size_bytes } = body;
  if (!blob_id || !original_name || !mime_type || typeof size_bytes !== 'number') {
    return res.status(400).json({ error: 'blob_id, original_name, mime_type, size_bytes required' });
  }
  if (!isAllowedMime(mime_type)) return res.status(415).json({ error: 'mime_not_allowed' });
  const cap = mime_type === 'application/pdf' ? PDF_MAX_BYTES : GENERIC_MAX_BYTES;
  if (size_bytes <= 0 || size_bytes > cap) {
    return res.status(413).json({ error: 'too_large', max_bytes: cap });
  }

  // Sync PDF extraction at confirm time → cached in extracted_text column.
  let extractedText: string | null = null;
  let extractionStatus = 'not_applicable';
  let extractedAt: Date | null = null;
  if (mime_type === 'application/pdf') {
    const r = await getPdfExtractor().extract(blob_id);
    extractedText = r.text || null;
    extractionStatus = r.status;
    extractedAt = new Date();
    logger.info(
      { slug: agent.slug, status: r.status, pages: r.pageCount, chars: r.text.length },
      'pdf:extract',
    );
  }

  const ins = await pool.query(
    `INSERT INTO task_uploads
       (agent_id, payer_address, walrus_blob_id, original_name, mime_type, size_bytes,
        extracted_text, extraction_status, extracted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, expires_at`,
    [
      agent.id,
      body.payer_address ? body.payer_address.toLowerCase() : null,
      blob_id, original_name, mime_type, size_bytes,
      extractedText, extractionStatus, extractedAt,
    ],
  );

  res.status(201).json({
    upload_id: ins.rows[0].id,
    expires_at: ins.rows[0].expires_at,
    extraction_status: extractionStatus,
  });
});

// ─── /:slug/try — unified free + paid dispatcher ───────────────────────

const FREE_DAILY_CAP = Number(process.env.OPENX_AGENT_FREE_DAILY_CAP ?? '5');
const freeBucket = new Map<string, { count: number; dayStart: number }>();
function checkFreeQuota(slug: string, ip: string): boolean {
  const today = Math.floor(Date.now() / 86_400_000);
  const key = `${slug}:${ip}`;
  const e = freeBucket.get(key);
  if (!e || e.dayStart !== today) {
    freeBucket.set(key, { count: 1, dayStart: today });
    return true;
  }
  if (e.count >= FREE_DAILY_CAP) return false;
  e.count += 1;
  return true;
}

function clientIp(req: Request): string {
  const xff = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim();
  return xff || req.ip || 'unknown';
}

async function answerWithAgent(
  req: Request,
  res: Response,
  agent: AgentRow,
  isPaid: boolean,
): Promise<void> {
  const body = (req.body ?? {}) as { q?: string; question?: string; message?: string; upload_ids?: string[] };
  const question = String(body.q ?? body.question ?? body.message ?? '').trim();
  if (!question) {
    res.status(400).json({ error: 'question_required' });
    return;
  }
  const uploadIds = Array.isArray(body.upload_ids) ? body.upload_ids.slice(0, 5) : [];

  let result;
  try {
    result = await runInference(getDeps(), agent, question, uploadIds);
  } catch (e) {
    logger.error({ err: (e as Error).message, slug: agent.slug }, 'agentInference:failed');
    res.status(502).json({ error: 'inference_failed', detail: (e as Error).message });
    return;
  }

  if (isPaid && req.agentSettlement) {
    res.json({
      ...result,
      settled: {
        tx_digest: req.agentSettlement.txDigest,
        amount_micro_usdc: req.agentSettlement.amountMicro.toString(),
        network: process.env.SUI_NETWORK ?? 'sui-testnet',
      },
    });
  } else {
    // Demo row in the ledger so the public feed reflects free traffic too.
    await ledger.record({
      agent_id: agent.id,
      slug: agent.slug,
      buyer: clientIp(req),
      amount_usdc: '0',
      tx_hash: ledger.demoTxHash(agent.slug, clientIp(req)),
      network: 'demo',
      method: 'demo',
    });
    res.json({ ...result, settled: null });
  }
}

// Free path — no payment_coin_object_id in body. Rate-limited to N/day per IP.
router.post('/:slug/try', async (req: Request, res: Response, next) => {
  if (req.body?.payment_coin_object_id) return next(); // hand off to paid mw
  const agent = await loadAgentBySlug(String(req.params.slug));
  if (!agent) return res.status(404).json({ error: 'agent_not_found' });
  if (!checkFreeQuota(agent.slug, clientIp(req))) {
    return res
      .status(429)
      .json({ error: 'free_daily_cap_reached', detail: `Pay $${agent.pricing?.sui_usdc ?? '?'} to continue` });
  }
  req.agentRow = agent;
  await answerWithAgent(req, res, agent, false);
});

// Paid path — requires X-Buyer-Address + payment_coin_object_id; agentX402Middleware settles.
router.post('/:slug/try', agentX402Middleware(), async (req: Request, res: Response) => {
  const agent = req.agentRow;
  if (!agent) return res.status(500).json({ error: 'agent_row_missing' });
  await answerWithAgent(req, res, agent, true);
});

// ─── /:slug/recent-calls — anonymized public ledger w/ 5s cache ─────────

interface RecentCallRow {
  tx_hash: string; payer: string; amount_usdc: string; method: string;
  network: string; settled_at: string;
}
const recentCache = new Map<string, { ts: number; rows: RecentCallRow[] }>();

function anonymize(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

router.get('/:slug/recent-calls', async (req: Request, res: Response) => {
  const slug = String(req.params.slug);
  const limit = Math.min(Math.max(Number(req.query.limit ?? '10'), 1), 50);

  const cacheKey = `${slug}:${limit}`;
  const cached = recentCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 5_000) {
    return res.json({ rows: cached.rows, cached: true });
  }

  const r = await pool.query<{ tx_hash: string; buyer: string; amount_usdc: string; method: string; network: string; created_at: Date }>(
    `SELECT tx_hash, buyer, amount_usdc, method, network, created_at
       FROM paid_calls
      WHERE slug = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [slug, limit],
  );
  const rows: RecentCallRow[] = r.rows.map((x) => ({
    tx_hash: x.tx_hash,
    payer: anonymize(x.buyer),
    amount_usdc: x.amount_usdc,
    method: x.method,
    network: x.network,
    settled_at: x.created_at.toISOString(),
  }));
  recentCache.set(cacheKey, { ts: Date.now(), rows });
  res.json({ rows, cached: false });
});

export default router;
