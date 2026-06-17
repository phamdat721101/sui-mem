/**
 * v3-marketplace — public catalog + seller-first publish surface (Sui-only).
 *
 *   Public:
 *     GET  /v3/marketplace/listings                  catalog
 *
 *   Auth-gated:
 *     POST  /v3/marketplace/seller/publish           atomic publish
 *     GET   /v3/marketplace/seller/me                seller profile
 *     PATCH /v3/marketplace/seller/me                update profile
 *     GET   /v3/marketplace/seller/dashboard         rolled-up earnings
 *
 * SOLID:
 *   - SRP: HTTP only. Business logic stays in `sellerPublishService.ts`.
 *   - DIP: pool is module-level (matches the rest of routes/*).
 */

import { Request, Response } from 'express';
import { hardenedRouter } from '../lib/routerSafety';
import { pool } from '../db';
import { logger } from '../lib';
import type { AuthRequest } from '../middleware/auth';
import { publish, type SellerPublishInput } from '../services/sellerPublishService';

const router = hardenedRouter();

const VALID_DOMAINS = new Set([
  'marketing', 'finance', 'research', 'engineering', 'generalist', 'other',
]);
const VALID_TIERS = new Set(['basic', 'verified', 'tee_attested']);

/**
 * Sui-only network gate (single source of truth for this file).
 * Migration 004 used 'sui' as the legacy alias; migration 022 widened to
 * 'sui-testnet' + 'sui-mainnet'. We accept all three so back-fills + future
 * mainnet rows both surface in the catalog. ARRAY[…] keeps the SQL planner
 * able to use the agents_chain index when present.
 */
const SUI_CHAINS = ['sui', 'sui-testnet', 'sui-mainnet'];

// ─── Public catalog ────────────────────────────────────────────────────────

router.get('/listings', async (req: Request, res: Response) => {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 100);
  const offset = Math.max(Number(req.query.offset ?? 0), 0);
  const domain = typeof req.query.domain === 'string' && VALID_DOMAINS.has(req.query.domain) ? req.query.domain : null;
  const tier = typeof req.query.tier === 'string' && VALID_TIERS.has(req.query.tier) ? req.query.tier : null;

  const params: Array<string | number | string[]> = [limit, offset, SUI_CHAINS];
  let where = `WHERE a.published = true AND a.chain = ANY($3::text[])`;
  if (domain) {
    params.push(domain);
    where += ` AND a.domain = $${params.length}`;
  }
  if (tier) {
    params.push(tier);
    where += ` AND a.verification_tier = $${params.length}`;
  }

  const r = await pool.query(
    `SELECT a.id, a.brain_id, a.slug, a.chain, a.domain, a.short_description,
            a.verification_tier, a.pricing, a.persona, a.created_at,
            b.title, b.description, b.tags
       FROM agents a
       JOIN brains b ON b.id = a.brain_id
       ${where}
   ORDER BY a.created_at DESC
      LIMIT $1 OFFSET $2`,
    params,
  );
  res.json({ listings: r.rows, limit, offset });
});

/**
 * GET /listings/:slug — single-row lookup. Replaces the wasteful "fetch
 * all + find" pattern on the buyer detail page. Distinguishes 404 (slug
 * doesn't exist) from 5xx (API blip) so the UI can render the right
 * message + retry button instead of falsely advertising "agent not found".
 *
 * SOLID: same JOIN + Sui-only filter as /listings, just keyed by slug.
 * No new query path — the planner uses the agents.slug UNIQUE index.
 */
router.get('/listings/:slug', async (req: Request, res: Response) => {
  const slug = String(req.params.slug ?? '').toLowerCase();
  if (!slug) return res.status(400).json({ error: 'slug required' });
  const r = await pool.query(
    `SELECT a.id, a.brain_id, a.slug, a.chain, a.domain, a.short_description,
            a.verification_tier, a.pricing, a.persona, a.created_at,
            b.title, b.description, b.tags
       FROM agents a
       JOIN brains b ON b.id = a.brain_id
      WHERE a.slug = $1 AND a.published = true AND a.chain = ANY($2::text[])
      LIMIT 1`,
    [slug, SUI_CHAINS],
  );
  if ((r.rowCount ?? 0) === 0) return res.status(404).json({ error: 'agent_not_found' });
  // Hint to browsers: do not cache a per-slug detail response. The detail
  // page is dynamic (recent-calls poll, status pills) and a stale cache
  // here was the latent cause of the "not found, refresh until it works"
  // false-positive.
  res.set('Cache-Control', 'no-store');
  res.json({ listing: r.rows[0] });
});

// ─── Auth-gated seller surface ─────────────────────────────────────────────

router.post('/seller/publish', async (req: AuthRequest, res: Response) => {
  if (!req.user?.address) return res.status(401).json({ error: 'auth required' });
  try {
    const apiBaseUrl = `${req.protocol}://${req.get('host')}`;
    const result = await publish(req.user.address, req.body as SellerPublishInput, { apiBaseUrl });
    logger.info(
      {
        wallet: req.user.address,
        slug: result.slug,
        domain: result.domain,
        chain: result.chain,
        seller_id: result.seller_id,
      },
      'marketplace:seller:publish:ok',
    );
    res.json(result);
  } catch (e) {
    const err = e as { status?: number; message?: string };
    const status = typeof err?.status === 'number' ? err.status : 500;
    logger.warn(
      { wallet: req.user.address, err: err?.message, status },
      'marketplace:seller:publish:failed',
    );
    res.status(status).json({ error: err?.message ?? 'publish failed' });
  }
});

router.get('/seller/me', async (req: AuthRequest, res: Response) => {
  if (!req.user?.address) return res.status(401).json({ error: 'auth required' });
  const owner = req.user.address.toLowerCase();
  const r = await pool.query(
    `SELECT id, wallet_address, display_name, bio, contact_email, support_url, created_at, updated_at
       FROM sellers WHERE wallet_address = $1`,
    [owner],
  );
  if (r.rowCount === 0) return res.json({ seller: null });
  res.json({ seller: r.rows[0] });
});

router.patch('/seller/me', async (req: AuthRequest, res: Response) => {
  if (!req.user?.address) return res.status(401).json({ error: 'auth required' });
  const owner = req.user.address.toLowerCase();
  const body = (req.body ?? {}) as Record<string, unknown>;
  const allowed = ['display_name', 'bio', 'contact_email', 'support_url'];
  const fields = allowed.filter((k) => body[k] !== undefined);
  if (fields.length === 0) return res.status(400).json({ error: 'no updatable fields' });

  const sets = fields.map((k, i) => `${k} = $${i + 2}`).join(', ');
  const params: Array<unknown> = [owner, ...fields.map((k) => body[k])];
  await pool.query(
    `INSERT INTO sellers (wallet_address, ${fields.join(', ')}, created_at, updated_at)
     VALUES ($1, ${fields.map((_, i) => `$${i + 2}`).join(', ')}, now(), now())
     ON CONFLICT (wallet_address) DO UPDATE SET ${sets}, updated_at = now()`,
    params,
  );
  res.json({ ok: true });
});

router.get('/seller/dashboard', async (req: AuthRequest, res: Response) => {
  if (!req.user?.address) return res.status(401).json({ error: 'auth required' });
  const owner = req.user.address.toLowerCase();
  const sellerRow = await pool.query(`SELECT id FROM sellers WHERE wallet_address = $1`, [owner]);
  if (sellerRow.rowCount === 0) return res.json({ seller: null, agents: [], earnings: null });
  const sellerId = sellerRow.rows[0].id;

  const [agents, earnings] = await Promise.all([
    pool.query(
      `SELECT a.id, a.slug, a.domain, a.verification_tier, a.created_at,
              COALESCE(SUM(pc.amount_usdc), 0)::text AS earned_total,
              COUNT(pc.id)::int                      AS calls_total
         FROM agents a
         LEFT JOIN paid_calls pc ON pc.agent_id = a.id
        WHERE a.seller_id = $1 AND a.chain = ANY($2::text[])
     GROUP BY a.id
     ORDER BY a.created_at DESC`,
      [sellerId, SUI_CHAINS],
    ),
    pool.query(
      `SELECT
         COALESCE(SUM(pc.amount_usdc) FILTER (WHERE pc.created_at > now() - interval '7 days'), 0)::text  AS last_7d,
         COALESCE(SUM(pc.amount_usdc) FILTER (WHERE pc.created_at > now() - interval '30 days'), 0)::text AS last_30d,
         COALESCE(SUM(pc.amount_usdc), 0)::text                                                            AS all_time,
         COUNT(*) FILTER (WHERE pc.created_at > now() - interval '7 days')                                 AS calls_7d
       FROM paid_calls pc
       JOIN agents a ON a.id = pc.agent_id
      WHERE a.seller_id = $1 AND a.chain = ANY($2::text[])`,
      [sellerId, SUI_CHAINS],
    ),
  ]);

  res.json({
    seller_id: sellerId,
    agents: agents.rows,
    earnings: earnings.rows[0] ?? { last_7d: '0', last_30d: '0', all_time: '0', calls_7d: 0 },
  });
});

// ─── Per-agent training (PRD-F) ──────────────────────────────────────────
//
// Owner-gated surface under /seller/agents/:slug/*. The detail page at
// /studio/agent/[slug]/train consumes these endpoints to record + recall
// every seller-initiated action against a specific agent. Buyer settlements
// (paid_calls) are UNION'd into the events feed at read time so the seller
// has a single audit timeline with explorer URLs.

const SUI_NETWORK = (process.env.SUI_NETWORK ?? 'sui-testnet') as 'sui-testnet' | 'sui-mainnet';
const SUI_EXPLORER = SUI_NETWORK === 'sui-mainnet' ? 'https://suiscan.xyz/mainnet' : 'https://suiscan.xyz/testnet';
const WALRUS_AGGREGATOR =
  process.env.WALRUS_AGGREGATOR_URL ?? 'https://aggregator.walrus-testnet.walrus.space';

interface OwnedAgent { id: string; brain_id: number; slug: string; owner_address: string }

/**
 * Resolve an agent by slug AND wallet ownership in one query. Returns null
 * for any miss (slug unknown OR slug owned by a different wallet) — the
 * routes return 404 in both cases so existence isn't leaked to non-owners.
 */
async function loadOwnedAgent(slug: string, wallet: string): Promise<OwnedAgent | null> {
  const r = await pool.query<OwnedAgent>(
    `SELECT id, brain_id, slug, owner_address
       FROM agents
      WHERE slug = $1
        AND lower(owner_address) = lower($2)
        AND chain = ANY($3::text[])`,
    [slug, wallet, SUI_CHAINS],
  );
  return r.rows[0] ?? null;
}

function explorerUrls(walrusBlobId: string | null, suiTxDigest: string | null) {
  return {
    walrus: walrusBlobId ? `${WALRUS_AGGREGATOR}/v1/blobs/${walrusBlobId}` : null,
    sui: suiTxDigest && !suiTxDigest.startsWith('local:') && !suiTxDigest.startsWith('demo:')
      ? `${SUI_EXPLORER}/tx/${suiTxDigest}`
      : null,
  };
}

// ─── Editable-config validators (mirror of sellerPublishService) ─────────
//
// SOLID: kept inline (5 lines) instead of exporting from publishService to
// preserve the publish-service's SRP. If the lists ever drift, validation
// is per-route which is the correct surface for a per-route validator.
const EDITABLE_DOMAINS = ['marketing', 'finance', 'research', 'engineering', 'generalist', 'other'] as const;
const EDITABLE_TIERS = ['basic', 'verified', 'tee_attested'] as const;
const EDITABLE_RAILS = ['x402', 'mpp', 'sui_usdc'] as const;
type EditableDomain = (typeof EDITABLE_DOMAINS)[number];
type EditableTier = (typeof EDITABLE_TIERS)[number];

interface AgentEditableRow {
  id: string;
  slug: string;
  brain_id: number;
  owner_address: string;
  domain: EditableDomain | null;
  short_description: string | null;
  long_description: string | null;
  verification_tier: EditableTier | null;
  tags: string[] | null;
  title: string | null;
  persona: { system_prompt?: string | null; tools?: string[] | null } | null;
  pricing: { x402?: string | null; mpp?: string | null; sui_usdc?: string | null } | null;
  /** Free /try calls per buyer per 24h. NULL = use OPENX_AGENT_FREE_DAILY_CAP env (5). */
  daily_request_cap: number | null;
  chain: string;
}

/**
 * GET /v3/marketplace/seller/agents/:slug — owner-only full editable record.
 * Joins agents + brains so the config page receives every editable field.
 */
router.get('/seller/agents/:slug', async (req: AuthRequest, res: Response) => {
  if (!req.user?.address) return res.status(401).json({ error: 'auth required' });
  const r = await pool.query<AgentEditableRow>(
    `SELECT a.id, a.slug, a.brain_id, a.owner_address, a.domain, a.short_description,
            b.description AS long_description,
            a.verification_tier, b.tags, b.title, a.persona, a.pricing, a.daily_request_cap, a.chain
       FROM agents a
       JOIN brains b ON b.id = a.brain_id
      WHERE a.slug = $1 AND lower(a.owner_address) = lower($2) AND a.chain = ANY($3::text[])`,
    [String(req.params.slug), req.user.address, SUI_CHAINS],
  );
  const a = r.rows[0];
  if (!a) return res.status(404).json({ error: 'agent_not_found' });
  res.json({ agent: a });
});

/**
 * PATCH /v3/marketplace/seller/agents/:slug — owner-only partial update.
 * Body: any subset of {title, persona, short_description, long_description,
 * domain, verification_tier, tags, pricing}. Per-field validation; only
 * fields actually present in the body are updated.
 *
 * agents-table columns vs brains-table columns are split (title/description/
 * tags live on brains; everything else on agents). Updates run in one tx.
 *
 * SOLID: this is the ONLY mutation surface for post-publish agent profile
 * edits. Pricing is read by middleware/agentX402.ts at request time, so a
 * PATCH takes effect on the very next paid call — no cache invalidation.
 */
router.patch('/seller/agents/:slug', async (req: AuthRequest, res: Response) => {
  // SOLID: errors from this handler (Postgres CHECK violations etc.) propagate
  // to the global errorHandler in lib/routerSafety.ts, which maps pg codes
  // 23502/23503/23505/23514/22P02 to clean 4xx responses. The hardenedRouter
  // wrapper in this file's `import` section makes async-throw → next(err)
  // automatic, so this handler does NOT need an inline try/catch.
  if (!req.user?.address) return res.status(401).json({ error: 'auth required' });
  const owned = await loadOwnedAgent(String(req.params.slug), req.user.address);
  if (!owned) return res.status(404).json({ error: 'agent_not_found' });
  const b = (req.body ?? {}) as {
    title?: string;
    persona?: { system_prompt?: string; tools?: string[] };
    short_description?: string;
    long_description?: string | null;
    domain?: string;
    verification_tier?: string;
    tags?: string[];
    pricing?: { x402?: string | null; mpp?: string | null; sui_usdc?: string | null };
    daily_request_cap?: number | null;
  };

  // Per-field validation. Only validate what's present.
  if (b.title !== undefined && (b.title.length < 3 || b.title.length > 120)) {
    return res.status(400).json({ error: 'title must be 3..120 chars' });
  }
  if (b.short_description !== undefined && (b.short_description.length < 10 || b.short_description.length > 240)) {
    return res.status(400).json({ error: 'short_description must be 10..240 chars' });
  }
  if (b.long_description !== undefined && b.long_description !== null && b.long_description.length > 4000) {
    return res.status(400).json({ error: 'long_description must be ≤4000 chars' });
  }
  if (b.domain !== undefined && !EDITABLE_DOMAINS.includes(b.domain as EditableDomain)) {
    return res.status(400).json({ error: `invalid domain (allowed: ${EDITABLE_DOMAINS.join(', ')})` });
  }
  if (b.verification_tier !== undefined && !EDITABLE_TIERS.includes(b.verification_tier as EditableTier)) {
    return res.status(400).json({ error: `invalid verification_tier (allowed: ${EDITABLE_TIERS.join(', ')})` });
  }
  if (b.tags !== undefined && (!Array.isArray(b.tags) || b.tags.length > 10)) {
    return res.status(400).json({ error: 'tags must be a string[] with ≤10 entries' });
  }
  if (b.persona?.system_prompt !== undefined && b.persona.system_prompt.trim().length < 10) {
    return res.status(400).json({ error: 'persona.system_prompt must be ≥10 chars' });
  }
  if (b.daily_request_cap !== undefined && b.daily_request_cap !== null) {
    if (!Number.isInteger(b.daily_request_cap) || b.daily_request_cap < 0 || b.daily_request_cap > 10000) {
      return res.status(400).json({ error: 'daily_request_cap must be an integer in [0, 10000]' });
    }
  }
  if (b.pricing) {
    for (const [rail, value] of Object.entries(b.pricing)) {
      if (!EDITABLE_RAILS.includes(rail as 'sui_usdc')) {
        return res.status(400).json({ error: `unknown pricing rail: ${rail}` });
      }
      if (value !== null && value !== undefined) {
        const num = Number(value);
        if (!(num > 0 && num <= 1000)) {
          return res.status(400).json({ error: `pricing.${rail} must be a decimal in (0, 1000]` });
        }
      }
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // agents-table updates
    const aSets: string[] = [];
    const aVals: unknown[] = [];
    let n = 1;
    if (b.short_description !== undefined) { aSets.push(`short_description = $${n++}`); aVals.push(b.short_description); }
    if (b.domain !== undefined)            { aSets.push(`domain            = $${n++}`); aVals.push(b.domain); }
    if (b.verification_tier !== undefined) { aSets.push(`verification_tier = $${n++}`); aVals.push(b.verification_tier); }
    if (b.daily_request_cap !== undefined) { aSets.push(`daily_request_cap = $${n++}`); aVals.push(b.daily_request_cap); }
    if (b.persona)                         { aSets.push(`persona = COALESCE(persona,'{}'::jsonb) || $${n++}::jsonb`); aVals.push(JSON.stringify(b.persona)); }
    if (b.pricing)                         { aSets.push(`pricing = COALESCE(pricing,'{}'::jsonb) || $${n++}::jsonb`); aVals.push(JSON.stringify(b.pricing)); }
    if (aSets.length > 0) {
      aVals.push(owned.id);
      await client.query(`UPDATE agents SET ${aSets.join(', ')} WHERE id = $${n}`, aVals);
    }

    // brains-table updates (title, description, tags)
    const bSets: string[] = [];
    const bVals: unknown[] = [];
    let m = 1;
    if (b.title !== undefined)            { bSets.push(`title       = $${m++}`); bVals.push(b.title); }
    if (b.long_description !== undefined) { bSets.push(`description = $${m++}`); bVals.push(b.long_description ?? ''); }
    if (b.tags !== undefined)             { bSets.push(`tags        = $${m++}`); bVals.push(b.tags); }
    if (bSets.length > 0) {
      bVals.push(owned.brain_id);
      await client.query(`UPDATE brains SET ${bSets.join(', ')} WHERE id = $${m}`, bVals);
    }

    if (aSets.length === 0 && bSets.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'no editable fields supplied' });
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }

  // Re-read for response
  const r = await pool.query<AgentEditableRow>(
    `SELECT a.id, a.slug, a.brain_id, a.owner_address, a.domain, a.short_description,
            b.description AS long_description,
            a.verification_tier, b.tags, b.title, a.persona, a.pricing, a.daily_request_cap, a.chain
       FROM agents a JOIN brains b ON b.id = a.brain_id WHERE a.id = $1`,
    [owned.id],
  );
  res.json({ agent: r.rows[0] });
});

/**
 * GET /v3/marketplace/agents/:slug/payment-info \u2014 public, no auth.
 * Single source of truth any client (human UI, agent host, MCP server) uses
 * to introspect payment requirements. Mirrors what middleware/agentX402.ts
 * will demand on a 402 challenge.
 */
router.get('/agents/:slug/payment-info', async (req: Request, res: Response) => {
  const r = await pool.query<{
    slug: string; owner_address: string;
    pricing: { sui_usdc?: string | null; x402?: string | null; mpp?: string | null } | null;
    daily_request_cap: number | null;
  }>(
    `SELECT slug, owner_address, pricing, daily_request_cap FROM agents
      WHERE slug = $1 AND published = true AND chain = ANY($2::text[])`,
    [String(req.params.slug), SUI_CHAINS],
  );
  const a = r.rows[0];
  if (!a) return res.status(404).json({ error: 'agent_not_found' });
  const price = a.pricing?.sui_usdc ?? a.pricing?.x402 ?? null;
  const apiBase = (req.headers['x-forwarded-proto'] && req.headers['x-forwarded-host'])
    ? `${req.headers['x-forwarded-proto']}://${req.headers['x-forwarded-host']}`
    : `${req.protocol}://${req.get('host')}`;
  res.json({
    slug: a.slug,
    payee_address: a.owner_address,
    price_usdc: price,
    asset_coin_type: process.env.OPENX_USDC_COIN_TYPE ?? null,
    chain: 'sui',
    network: process.env.SUI_NETWORK ?? 'testnet',
    paywall_url: `${apiBase}/v3/agents/${a.slug}/try`,
    public_url: `${apiBase}/api/v1/${a.slug}`,
    daily_request_cap: a.daily_request_cap ?? Number(process.env.OPENX_AGENT_FREE_DAILY_CAP ?? '5'),
    platform_treasury: process.env.OPENX_PLATFORM_TREASURY ?? null,
    platform_bps: Math.min(Math.max(Number(process.env.OPENX_PLATFORM_BPS ?? '500'), 0), 10_000),
  });
});

/**
 * GET /seller/agents/:slug/events — unified history feed.
 * UNIONs agent_training_events with paid_calls (mapped to event_type='settle').
 */
router.get('/seller/agents/:slug/events', async (req: AuthRequest, res: Response) => {
  if (!req.user?.address) return res.status(401).json({ error: 'auth required' });
  const agent = await loadOwnedAgent(String(req.params.slug), req.user.address);
  if (!agent) return res.status(404).json({ error: 'agent_not_found' });
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);

  const r = await pool.query<{
    event_type: string;
    walrus_blob_id: string | null;
    sui_tx_digest: string | null;
    namespace: string | null;
    summary: string | null;
    created_at: Date;
  }>(
    `(
       SELECT event_type, walrus_blob_id, sui_tx_digest, namespace, summary, created_at
         FROM agent_training_events
        WHERE agent_id = $1
     )
     UNION ALL
     (
       SELECT 'settle' AS event_type,
              NULL     AS walrus_blob_id,
              tx_hash  AS sui_tx_digest,
              NULL     AS namespace,
              ('paid call · $' || amount_usdc::text || ' · ' || method) AS summary,
              created_at
         FROM paid_calls
        WHERE agent_id = $1
     )
     ORDER BY created_at DESC
     LIMIT $2`,
    [agent.id, limit],
  );

  res.set('Cache-Control', 'no-store');
  res.json({
    events: r.rows.map((row) => ({
      event_type: row.event_type,
      walrus_blob_id: row.walrus_blob_id,
      sui_tx_digest: row.sui_tx_digest,
      namespace: row.namespace,
      summary: row.summary,
      created_at: row.created_at.toISOString(),
      explorer_urls: explorerUrls(row.walrus_blob_id, row.sui_tx_digest),
    })),
  });
});

/**
 * POST /seller/agents/:slug/upload — record a Walrus blob the seller already PUT.
 * Body: { walrus_blob_id, original_name, mime_type, size_bytes }
 */
router.post('/seller/agents/:slug/upload', async (req: AuthRequest, res: Response) => {
  if (!req.user?.address) return res.status(401).json({ error: 'auth required' });
  const agent = await loadOwnedAgent(String(req.params.slug), req.user.address);
  if (!agent) return res.status(404).json({ error: 'agent_not_found' });
  const b = (req.body ?? {}) as {
    walrus_blob_id?: string; original_name?: string; mime_type?: string; size_bytes?: number;
  };
  if (!b.walrus_blob_id || !b.original_name || !b.mime_type || typeof b.size_bytes !== 'number') {
    return res.status(400).json({ error: 'walrus_blob_id, original_name, mime_type, size_bytes required' });
  }
  const summary = `${b.original_name} · ${b.mime_type} · ${Math.round(b.size_bytes / 1024)}KB`;
  const ins = await pool.query<{ id: string; created_at: Date }>(
    `INSERT INTO agent_training_events (agent_id, event_type, walrus_blob_id, summary)
     VALUES ($1, 'upload', $2, $3)
     RETURNING id, created_at`,
    [agent.id, b.walrus_blob_id, summary],
  );

  // Bug B fix — chunk the uploaded file into knowledge_chunks so the agent
  // can RAG over it via agentInference.recallFromKnowledgeChunks. The browser
  // PUT the file directly to Walrus; we now fetch + extract + chunk on the
  // server. Best-effort: failure here does NOT fail the upload (the metadata
  // event was already recorded above). Skip files >10MB or unsupported types.
  //
  // SOLID: reuses the singleton PdfExtractor + the shared createWalrusStore
  // — no new file, no new dep.
  const CHUNK_MAX_BYTES = 10 * 1024 * 1024;
  const CHUNK_WINDOW_CHARS = 1500;
  const m = b.mime_type;
  const isText = m.startsWith('text/') || m === 'application/json' || m === 'application/x-yaml' || m === 'application/yaml';
  const isPdf = m === 'application/pdf';
  let chunks_written = 0;
  if ((isText || isPdf) && b.size_bytes <= CHUNK_MAX_BYTES) {
    try {
      let extracted = '';
      if (isPdf) {
        const { getPdfExtractor } = await import('../services/pdfExtractor');
        const r = await getPdfExtractor().extract(b.walrus_blob_id);
        if (r.status === 'ok') extracted = r.text;
      } else {
        const { createWalrusStore } = await import('@fhe-ai-context/sui-sdk');
        const bytes = await createWalrusStore().fetch(b.walrus_blob_id);
        extracted = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      }
      const trimmed = extracted.trim();
      if (trimmed.length >= 20) {
        const idxRow = await pool.query<{ max: number | string }>(
          `SELECT COALESCE(MAX(chunk_index), -1) AS max FROM knowledge_chunks WHERE brain_id = $1`,
          [agent.brain_id],
        );
        let nextIdx = Number(idxRow.rows[0]?.max ?? -1) + 1;
        for (let i = 0; i < trimmed.length; i += CHUNK_WINDOW_CHARS) {
          const piece = trimmed.slice(i, i + CHUNK_WINDOW_CHARS);
          await pool.query(
            `INSERT INTO knowledge_chunks (brain_id, chunk_index, content) VALUES ($1, $2, $3)`,
            [agent.brain_id, nextIdx++, piece],
          );
          chunks_written++;
        }
      }
    } catch (chunkErr) {
      logger.warn(
        { brainId: agent.brain_id, blob: b.walrus_blob_id, err: (chunkErr as Error)?.message },
        'training:upload:chunk-failed',
      );
    }
  }

  res.status(201).json({ id: ins.rows[0].id, created_at: ins.rows[0].created_at, chunks_written });
});

/**
 * POST /seller/agents/:slug/remember — write knowledge to MemWal under
 * the agent's brain namespace. Body: { text, level: 2|3|4 }.
 *
 * Posts to the existing /v3/memory/remember endpoint internally so the
 * mock-fallback + dual-write into knowledge_chunks behavior carries through
 * without duplication.
 */
router.post('/seller/agents/:slug/remember', async (req: AuthRequest, res: Response) => {
  if (!req.user?.address) return res.status(401).json({ error: 'auth required' });
  const agent = await loadOwnedAgent(String(req.params.slug), req.user.address);
  if (!agent) return res.status(404).json({ error: 'agent_not_found' });
  const b = (req.body ?? {}) as { text?: string; level?: number };
  const text = String(b.text ?? '').trim();
  if (text.length < 4) return res.status(400).json({ error: 'text >= 4 chars required' });
  const level = b.level === 2 || b.level === 4 ? b.level : 3;
  const namespace = `cog-l${level}-${agent.brain_id}`;

  // Forward to the internal memwal route via loopback to avoid the public
  // Caddy round-trip (PUBLIC_API_URL is the public hostname; intra-process
  // calls should never leave the VPS).
  const apiBase = `http://127.0.0.1:${process.env.PORT ?? '3001'}`;
  let blobId: string | null = null;
  let mode: string | null = null;
  try {
    const r = await fetch(`${apiBase}/v3/memory/remember`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-wallet-address': req.user.address, 'x-chain': 'sui' },
      body: JSON.stringify({ text, namespace }),
    });
    const j = (await r.json()) as { ok?: boolean; blob_id?: string | null; mode?: string };
    if (!r.ok || j.ok !== true) {
      logger.warn({ status: r.status, body: j }, 'training:remember:upstream_failed');
      return res.status(502).json({ error: 'memwal_remember_failed', detail: j });
    }
    blobId = j.blob_id ?? null;
    mode = j.mode ?? null;
  } catch (e) {
    logger.error({ err: (e as Error).message }, 'training:remember:fetch_failed');
    return res.status(502).json({ error: 'memwal_remember_failed' });
  }

  const summary = text.slice(0, 200);
  const ins = await pool.query<{ id: string; created_at: Date }>(
    `INSERT INTO agent_training_events (agent_id, event_type, walrus_blob_id, namespace, summary)
     VALUES ($1, 'remember', $2, $3, $4)
     RETURNING id, created_at`,
    [agent.id, blobId, namespace, summary],
  );
  res.status(201).json({
    id: ins.rows[0].id,
    walrus_blob_id: blobId,
    namespace,
    mode,
    created_at: ins.rows[0].created_at,
  });
});

/**
 * POST /seller/agents/:slug/training-loop — one Reflexion-style iteration.
 *   1. Read the agent's persona system_prompt (the "what should I know" anchor).
 *   2. Bedrock 1-shot self-critique → returns a short "what's missing"-style note.
 *   3. memwal.remember the note under cog-l5-{brain_id} (reflective namespace).
 *   4. Record an `agent_training_events` row.
 */
router.post('/seller/agents/:slug/training-loop', async (req: AuthRequest, res: Response) => {
  if (!req.user?.address) return res.status(401).json({ error: 'auth required' });
  const agent = await loadOwnedAgent(String(req.params.slug), req.user.address);
  if (!agent) return res.status(404).json({ error: 'agent_not_found' });

  // Load persona for the critique seed.
  const personaRow = await pool.query<{ persona: { system_prompt?: string | null } | null }>(
    `SELECT persona FROM agents WHERE id = $1`,
    [agent.id],
  );
  const systemPrompt = (personaRow.rows[0]?.persona?.system_prompt ?? '').trim();

  // Bedrock self-critique (1 inference).
  let critique: string;
  try {
    const { createLlmClient } = await import('@fhe-ai-context/sui-sdk');
    const llm = createLlmClient();
    const r = await llm.infer(
      [
        {
          role: 'system',
          content:
            'You are an expert agent-quality auditor. Given the agent\'s persona prompt below, ' +
            'identify 1-3 concrete knowledge gaps or weak spots that would make this agent answer ' +
            'poorly. Output a short bulleted list (max 6 lines). Be specific and actionable.',
        },
        { role: 'user', content: systemPrompt || '(empty persona — agent has no system prompt yet)' },
      ],
      { maxTokens: 256, temperature: 0.3 },
    );
    critique = r.answer.trim();
  } catch (e) {
    logger.error({ err: (e as Error).message, slug: agent.slug }, 'training:loop:bedrock_failed');
    return res.status(502).json({ error: 'bedrock_failed', detail: (e as Error).message });
  }
  if (!critique) {
    return res.status(502).json({ error: 'bedrock_empty_response' });
  }

  // Persist via memwal /remember (same path as /seller/agents/:slug/remember).
  const namespace = `cog-l5-${agent.brain_id}`;
  const apiBase = `http://127.0.0.1:${process.env.PORT ?? '3001'}`;
  let blobId: string | null = null;
  try {
    const r = await fetch(`${apiBase}/v3/memory/remember`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-wallet-address': req.user.address, 'x-chain': 'sui' },
      body: JSON.stringify({ text: critique, namespace }),
    });
    const j = (await r.json()) as { blob_id?: string | null };
    blobId = j.blob_id ?? null;
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'training:loop:memwal_warn');
  }

  const ins = await pool.query<{ id: string; created_at: Date }>(
    `INSERT INTO agent_training_events (agent_id, event_type, walrus_blob_id, namespace, summary)
     VALUES ($1, 'reflect', $2, $3, $4)
     RETURNING id, created_at`,
    [agent.id, blobId, namespace, critique.slice(0, 500)],
  );
  res.json({
    id: ins.rows[0].id,
    walrus_blob_id: blobId,
    namespace,
    critique,
    created_at: ins.rows[0].created_at,
  });
});

export default router;
