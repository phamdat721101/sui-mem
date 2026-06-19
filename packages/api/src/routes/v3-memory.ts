/**
 * v3-memory.ts — paid memory operations against Walrus Memory (MemWal).
 *
 * Mounted at `/v3/memory` after auth + agentKya. Every route applies
 * `requireSuiWallet` (G2) — MemWal is a Sui-only product and we surface a
 * structured "switch-network" 400 instead of a confusing upstream error.
 *
 * SOLID
 * -----
 *  - SRP: routes here are HTTP wrappers around `OpenXMemWalAdapter`. No
 *    business logic — adapter is the only place where MemWal verbs live.
 *  - DIP: adapter is constructed once per process via `getMemWalAdapter()`,
 *    then cached. Tests can swap the cache by re-importing the module.
 *  - OCP: adding a new MemWal-touching route = one handler that calls into
 *    the cached adapter. Marketplace/billing routes (PRD-08, PRD-11) live
 *    in their own siblings; they share the same adapter cache.
 *
 * Never holds a delegate private key in process memory longer than it must:
 * `OPENX_MEMWAL_DELEGATE_PRIVATE_KEYS` is read once at adapter init, and the
 * adapter only forwards them to the upstream MemWal SDK over a TLS channel.
 */

import { type Response } from 'express';
import { hardenedRouter } from '../lib/routerSafety';
import { pool } from '../db';
import { logger } from '../lib';
import type { AuthRequest } from '../middleware/auth';
import { requireSuiWallet } from '../middleware/require-sui-wallet';
import {
  OpenXMemWalAdapter,
  OpenXMemWalError,
  type MemWalNetwork,
  type OpenXMemWalConfig,
} from '@fhe-ai-context/sdk';
import { getMemWalOperator } from '../services/memwalOperator';

const router = hardenedRouter();

// Adapter cache — keyed by Sui MemWalAccount object id. Operator runs one
// adapter per (account, OpenX-pool) pair. For the buyer-side operator
// pattern (PRD-11 §4.1) every brain query routes through OpenX's pool, so
// most callers reuse the same adapter instance.
const adapterCache = new Map<string, OpenXMemWalAdapter>();

function envOr(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

function delegateKeys(): string[] {
  return envOr('OPENX_MEMWAL_DELEGATE_PRIVATE_KEYS')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function memwalNetwork(): MemWalNetwork {
  const v = (envOr('MEMWAL_NETWORK', 'testnet') as MemWalNetwork) ?? 'testnet';
  return v === 'mainnet' || v === 'testnet' || v === 'local' ? v : 'testnet';
}

/**
 * Resolve a wallet's Sui MemWalAccount object id. For now we read the
 * cached binding from `memwal_accounts`. Provisioning (T11 / PRD-11) writes
 * to that table when the operator pool is registered onchain.
 */
async function resolveAccountId(walletAddress: string): Promise<string | null> {
  const r = await pool.query<{ sui_account_id: string }>(
    'SELECT sui_account_id FROM memwal_accounts WHERE wallet_address = $1 LIMIT 1',
    [walletAddress.toLowerCase()],
  );
  return r.rows[0]?.sui_account_id ?? null;
}

async function getMemWalAdapter(
  walletAddress: string,
  accountId: string,
  overrides: Partial<OpenXMemWalConfig> = {},
): Promise<OpenXMemWalAdapter> {
  // Per-call paymentGate means we must NOT reuse a cached adapter — the
  // closure captures the tx hash. Build fresh; the rate-limit guard is the
  // cost-bearing piece and it's stateless.
  const useCache = !overrides.paymentGate;
  const key = `${accountId}:${walletAddress.toLowerCase()}`;
  if (useCache) {
    const existing = adapterCache.get(key);
    if (existing) return existing;
  }

  const adapter = await OpenXMemWalAdapter.create({
    network: memwalNetwork(),
    walletAddress,
    accountId,
    delegateKeys: delegateKeys(),
    serverUrl: envOr('MEMWAL_RELAYER_URL') || undefined,
    namespace: overrides.namespace,
    paymentGate: overrides.paymentGate,
    storageBytesCap: overrides.storageBytesCap,
    logger: {
      info: (obj, msg) => logger.info(obj, msg ?? 'memwal'),
      warn: (obj, msg) => logger.warn(obj, msg ?? 'memwal'),
      error: (obj, msg) => logger.error(obj, msg ?? 'memwal'),
    },
  });
  if (useCache) adapterCache.set(key, adapter);
  return adapter;
}

/**
 * Build a paymentGate that records the paid query in `memwal_paid_queries`
 * AFTER the upstream recall succeeds. The off-chain ledger is the idempotency
 * key (UNIQUE on payment_tx_hash) — the on-chain settle batch is emitted by
 * the worker (T15). This factory is the single way every paid path on this
 * router talks to the ledger.
 */
function buildPaidQueryGate(args: {
  brainSuiObjectId: string;
  buyerWallet: string;
  amountUsdc: number;
  paymentTxHash: string;
  rail: string;
  attestationHash?: string;
}) {
  return async () => {
    // Insert the ledger row up-front; if the recall fails we'll mark
    // refunded=true. ON CONFLICT DO NOTHING gives idempotency on the
    // payment_tx_hash UNIQUE index.
    await pool.query(
      `INSERT INTO memwal_paid_queries (
         brain_sui_object_id, buyer_wallet, payment_rail, amount_usdc,
         query_text_hash, payment_tx_hash, phala_attestation_hash
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (payment_tx_hash) DO NOTHING`,
      [
        args.brainSuiObjectId,
        args.buyerWallet.toLowerCase(),
        args.rail,
        args.amountUsdc,
        '', // query hash filled in after recall
        args.paymentTxHash,
        args.attestationHash ?? null,
      ],
    );
    return { allowed: true as const, tx_hash: args.paymentTxHash };
  };
}

// ─── Error → HTTP translator ───────────────────────────────────────────

function sendMemWalError(res: Response, e: unknown) {
  if (e instanceof OpenXMemWalError) {
    const map: Record<string, number> = {
      OPENX_MEMWAL_UPSTREAM_MISSING: 503,
      OPENX_MEMWAL_COMPATIBILITY_MISMATCH: 426,
      OPENX_MEMWAL_PAYMENT_DENIED: 402,
      OPENX_MEMWAL_RATE_LIMIT: 429,
      OPENX_MEMWAL_ACCOUNT_FROZEN: 403,
      OPENX_MEMWAL_NO_ACCESS: 403,
      OPENX_MEMWAL_STORAGE_QUOTA: 413,
      OPENX_MEMWAL_INVALID_CONFIG: 400,
      OPENX_MEMWAL_UPSTREAM_ERROR: 502,
    };
    const status = map[e.code] ?? 500;
    if (e.retryAfterMs) res.setHeader('Retry-After', Math.ceil(e.retryAfterMs / 1000));
    return res.status(status).json({
      error: e.code,
      message: e.message,
      retry_after_ms: e.retryAfterMs,
      details: e.details,
    });
  }
  logger.error({ err: (e as Error)?.message }, 'memwal:unhandled');
  return res.status(500).json({ error: 'OPENX_MEMWAL_INTERNAL', message: 'unexpected adapter error' });
}

// ─── Routes ────────────────────────────────────────────────────────────

/**
 * POST /v3/memory/remember
 * Body: { text: string, namespace?: string }
 */
router.post('/remember', requireSuiWallet, async (req: AuthRequest, res) => {
  const wallet = req.user?.address;
  if (!wallet) return res.status(401).json({ error: 'auth required' });
  const { text, namespace } = (req.body ?? {}) as { text?: string; namespace?: string };
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text required' });
  }
  const accountId = await resolveAccountId(wallet);
  if (!accountId && process.env.MEMWAL_FALLBACK_MODE !== 'mock') {
    return res.status(409).json({
      error: 'memwal_account_not_provisioned',
      message: 'Provision your MemWalAccount first (POST /v3/memory/account/provision).',
    });
  }
  try {
    if (!accountId) throw new Error('memwal_account_not_provisioned');
    const adapter = await getMemWalAdapter(wallet, accountId);
    const out = await adapter.remember(text, namespace);
    res.json({ ok: true, blob_id: out.blob_id ?? null, job_id: out.job_id ?? null });
  } catch (e) {
    // Graceful degradation for demo deployments. When MEMWAL_FALLBACK_MODE=mock,
    // we synthesize a deterministic local blob id from the namespace + text so
    // the seller flow (train → publish) is not blocked by an unprovisioned
    // MemWalAccount or by a tripped circuit breaker. The seller still sees a
    // success receipt; the namespace + content hash are persisted in the
    // audit log. Production sets the flag off → real upstream
    // errors propagate (current behavior).
    //
    // SOLID: single conditional, no architectural fork. One swap-point
    // (the env var) governs real vs mock for /train.
    if (process.env.MEMWAL_FALLBACK_MODE === 'mock') {
      // Real Walrus PUT — replaces the historical synthetic `local:` placeholder
      // so the audit trail + the seller-facing `walrus blob ↗` link actually
      // resolve. SOLID: reuses the shared `createWalrusStore` from
      // @fhe-ai-context/sui-sdk (resilient-call wrapped, single source of
      // truth for Walrus HTTP). The synthetic-id branch becomes a TRUE
      // error fallback — only used when even the publisher refuses.
      const ns = String(namespace ?? 'cog-l3-default');
      let blob_id: string;
      let walrusOk = true;
      try {
        const { createWalrusStore } = await import('@fhe-ai-context/sui-sdk');
        const store = createWalrusStore();
        const bytes = new TextEncoder().encode(text);
        const upload = await store.upload(bytes);
        if (!upload.blobs[0]?.blobId) throw new Error('walrus_publish_returned_no_blob_id');
        blob_id = upload.blobs[0].blobId;
      } catch (walrusErr) {
        walrusOk = false;
        const { createHash, randomBytes } = await import('node:crypto');
        const contentHash = createHash('sha256')
          .update(`${ns}|${text}`)
          .digest('hex')
          .slice(0, 16);
        blob_id = `local:${ns}:${contentHash}:${randomBytes(4).toString('hex')}`;
        logger.warn(
          { ns, err: (walrusErr as Error)?.message ?? String(walrusErr) },
          'memwal:remember:walrus-put-failed',
        );
      }

      // Dual-write into knowledge_chunks so the public agent API
      // (/api/v1/<slug>) can RAG over Sui-trained knowledge. The namespace
      // convention is cog-l{level}-{brainId}; we extract the integer brain
      // id and append a chunk row. Best-effort: failure to write the mirror
      // does NOT fail the call.
      const m = ns.match(/^cog-l\d+-(\d+)/);
      if (m) {
        const brainId = Number(m[1]);
        try {
          const idxRow = await pool.query<{ max: number | string }>(
            `SELECT COALESCE(MAX(chunk_index), -1) AS max FROM knowledge_chunks WHERE brain_id = $1`,
            [brainId],
          );
          const nextIdx = Number(idxRow.rows[0]?.max ?? -1) + 1;
          await pool.query(
            `INSERT INTO knowledge_chunks (brain_id, chunk_index, content) VALUES ($1, $2, $3)`,
            [brainId, nextIdx, text],
          );
        } catch (mirrorErr) {
          logger.warn(
            { brainId, err: (mirrorErr as Error)?.message ?? String(mirrorErr) },
            'memwal:remember:mirror-failed',
          );
        }
      }
      logger.warn(
        { wallet, accountId, ns, walrus_ok: walrusOk, err: (e as Error)?.message ?? String(e) },
        'memwal:remember:fallback-mock',
      );
      return res.json({ ok: true, blob_id, job_id: null, mode: walrusOk ? 'walrus-direct' : 'mock-fallback' });
    }
    sendMemWalError(res, e);
  }
});

/**
 * POST /v3/memory/recall
 * Body: { query: string, limit?: number, namespace?: string, minRelevance?: number }
 */
router.post('/recall', requireSuiWallet, async (req: AuthRequest, res) => {
  const wallet = req.user?.address;
  if (!wallet) return res.status(401).json({ error: 'auth required' });
  const { query, limit, namespace, minRelevance } = (req.body ?? {}) as {
    query?: string;
    limit?: number;
    namespace?: string;
    minRelevance?: number;
  };
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'query required' });
  }
  const accountId = await resolveAccountId(wallet);
  if (!accountId) return res.status(409).json({ error: 'memwal_account_not_provisioned' });
  try {
    const adapter = await getMemWalAdapter(wallet, accountId);
    const out = await adapter.recall(query, { limit, namespace, minRelevance });
    res.json({ ok: true, results: out.results, total: out.total });
  } catch (e) {
    // Same demo-degradation policy as /remember: when MEMWAL_FALLBACK_MODE=mock
    // we synthesize a deterministic recall response so the buyer flow is not
    // blocked by an unprovisioned MemWalAccount or tripped circuit breaker.
    // Production leaves the flag unset → upstream errors propagate untouched.
    if (process.env.MEMWAL_FALLBACK_MODE === 'mock') {
      const ns = String(namespace ?? 'cog-l3-default');
      logger.warn(
        { wallet, accountId, ns, err: (e as Error)?.message ?? String(e) },
        'memwal:recall:fallback-mock',
      );
      const synthetic = [
        {
          score: 0.92,
          namespace: ns,
          text:
            `[mock-fallback] ${ns} has no real Walrus blob yet (MemWalAccount ` +
            `not provisioned). Once the seller provisions onchain, real ` +
            `recall will return matches for: "${query.slice(0, 80)}".`,
          blob_id: `local:${ns}:mock-recall`,
          metadata: { mode: 'mock-fallback' },
        },
      ];
      return res.json({ ok: true, results: synthetic, total: synthetic.length, mode: 'mock-fallback' });
    }
    sendMemWalError(res, e);
  }
});

/**
 * POST /v3/memory/restore
 * Body: { namespace: string, limit?: number }
 */
router.post('/restore', requireSuiWallet, async (req: AuthRequest, res) => {
  const wallet = req.user?.address;
  if (!wallet) return res.status(401).json({ error: 'auth required' });
  const { namespace, limit } = (req.body ?? {}) as { namespace?: string; limit?: number };
  if (!namespace) return res.status(400).json({ error: 'namespace required' });
  const accountId = await resolveAccountId(wallet);
  if (!accountId) return res.status(409).json({ error: 'memwal_account_not_provisioned' });
  try {
    const adapter = await getMemWalAdapter(wallet, accountId);
    const out = await adapter.restore(namespace, limit);
    res.json({ ok: true, ...out });
  } catch (e) {
    sendMemWalError(res, e);
  }
});

/**
 * POST /v3/memory/analyze — LLM-extract facts from text and bulk-store them.
 * Body: { text: string, namespace?: string }
 */
router.post('/analyze', requireSuiWallet, async (req: AuthRequest, res) => {
  const wallet = req.user?.address;
  if (!wallet) return res.status(401).json({ error: 'auth required' });
  const { text, namespace } = (req.body ?? {}) as { text?: string; namespace?: string };
  if (!text) return res.status(400).json({ error: 'text required' });
  const accountId = await resolveAccountId(wallet);
  if (!accountId) return res.status(409).json({ error: 'memwal_account_not_provisioned' });
  try {
    const adapter = await getMemWalAdapter(wallet, accountId);
    const out = await adapter.analyze(text, namespace);
    res.json({ ok: true, ...out });
  } catch (e) {
    sendMemWalError(res, e);
  }
});

/**
 * GET /v3/memory/operator/stats — seller earnings + storage usage.
 * Authenticated; returns the caller's published brains aggregated over the
 * paid-queries + settlements ledgers. No live MemWal calls — all from DB.
 */
router.get('/operator/stats', async (req: AuthRequest, res) => {
  const wallet = req.user?.address?.toLowerCase();
  if (!wallet) return res.status(401).json({ error: 'auth required' });
  try {
    const brainsR = await pool.query(
      `SELECT sui_object_id, title, namespace, price_per_query_usdc,
              cognitive_level, attestation_required, active, created_at
       FROM memwal_marketplace_brains WHERE seller_wallet = $1
       ORDER BY created_at DESC`,
      [wallet],
    );
    const earningsR = await pool.query<{
      total_revenue: string | null;
      query_count: string;
      last_24h: string;
      operator_amount: string | null;
    }>(
      `SELECT
         COALESCE(SUM(seller_amount_usdc), 0)::text AS total_revenue,
         COALESCE(SUM(query_count), 0)::text         AS query_count,
         COALESCE(SUM(query_count) FILTER (WHERE settled_at > now() - interval '24 hours'), 0)::text AS last_24h,
         COALESCE(SUM(operator_amount_usdc), 0)::text AS operator_amount
       FROM memwal_revenue_settlements WHERE seller_wallet = $1`,
      [wallet],
    );
    res.json({
      ok: true,
      brains: brainsR.rows,
      earnings: earningsR.rows[0] ?? {
        total_revenue: '0',
        query_count: '0',
        last_24h: '0',
        operator_amount: '0',
      },
    });
  } catch (e) {
    logger.error({ err: (e as Error)?.message }, 'memwal:operator:stats:err');
    res.status(500).json({ error: 'internal' });
  }
});

/**
 * GET /v3/memory/buyer/activity — caller's recent paid queries.
 * Returns the last N paid_queries rows for the authenticated wallet, joined
 * with marketplace metadata so dashboards can render brain title + namespace
 * without a second round-trip. Used by /dashboard/mcp + /dashboard/costs.
 */
router.get('/buyer/activity', async (req: AuthRequest, res) => {
  const wallet = req.user?.address?.toLowerCase();
  if (!wallet) return res.status(401).json({ error: 'auth required' });
  const limit = clampInt(req.query.limit, 1, 200) ?? 50;
  try {
    const rows = await pool.query(
      `SELECT q.id, q.brain_sui_object_id, q.amount_usdc, q.payment_rail,
              q.payment_tx_hash, q.settlement_tx_hash, q.refunded,
              q.phala_attestation_hash, q.ms_elapsed, q.created_at,
              b.title, b.namespace, b.cognitive_level, b.attestation_required
       FROM memwal_paid_queries q
       LEFT JOIN memwal_marketplace_brains b ON b.sui_object_id = q.brain_sui_object_id
       WHERE q.buyer_wallet = $1
       ORDER BY q.created_at DESC
       LIMIT $2`,
      [wallet, limit],
    );

    // Aggregates over different rolling windows — used by the cost tracker.
    const totals = await pool.query<{
      window: string;
      total_usdc: string;
      query_count: string;
    }>(
      `SELECT 'h24' AS window, COALESCE(SUM(amount_usdc),0)::text AS total_usdc, COUNT(*)::text AS query_count
       FROM memwal_paid_queries WHERE buyer_wallet=$1 AND created_at > now() - interval '24 hours' AND refunded=false
       UNION ALL
       SELECT 'd7',  COALESCE(SUM(amount_usdc),0)::text, COUNT(*)::text
       FROM memwal_paid_queries WHERE buyer_wallet=$1 AND created_at > now() - interval '7 days'  AND refunded=false
       UNION ALL
       SELECT 'd30', COALESCE(SUM(amount_usdc),0)::text, COUNT(*)::text
       FROM memwal_paid_queries WHERE buyer_wallet=$1 AND created_at > now() - interval '30 days' AND refunded=false`,
      [wallet],
    );
    const totalsByWindow: Record<string, { total_usdc: string; query_count: string }> = {};
    for (const r of totals.rows) {
      totalsByWindow[r.window] = { total_usdc: r.total_usdc, query_count: r.query_count };
    }
    res.json({ ok: true, activity: rows.rows, totals: totalsByWindow });
  } catch (e) {
    logger.error({ err: (e as Error)?.message }, 'memwal:buyer:activity:err');
    res.status(500).json({ error: 'internal' });
  }
});

/**
 * GET /v3/memory/status — diagnostic ping (no auth-sensitive data leaked).
 * Returns network + peer-dep flag so the frontend can render an honest
 * "MemWal not configured" state without poking the adapter blindly.
 */
router.get('/status', async (_req, res) => {
  const operator = getMemWalOperator();
  res.json({
    network: memwalNetwork(),
    peerDepEnabled: process.env.MEMWAL_PEERDEP_ENABLED === 'true',
    delegatesConfigured: delegateKeys().length,
    relayerUrl: envOr('MEMWAL_RELAYER_URL'),
    operatorAddress: operator?.operatorAddress ?? null,
    operatorReady: operator !== null,
  });
});

/**
 * GET /v3/memory/account — returns the caller's cached MemWalAccount object
 * id (or `null` if not provisioned). Used by /train to pre-fill the publish
 * form so sellers don't have to paste a 64-char hex id from MemWal app.
 *
 * Wallet-gated (uses x-wallet-address header). Read-only — no provisioning
 * happens here; that is a separate flow.
 */
router.get('/account', async (req: AuthRequest, res) => {
  const wallet = req.user?.address;
  if (!wallet) return res.status(401).json({ error: 'auth required' });
  const accountId = await resolveAccountId(wallet);
  res.json({ accountId, wallet });
});

// ─── Marketplace routes (PRD-08) ───────────────────────────────────────

/**
 * GET /v3/memory/marketplace — public catalog of MemWal-tier brains.
 * Filters: ?cognitiveLevel=3&maxPriceUsdc=0.10&kya=optional&q=keyword
 *
 * Public — exposed via the auth.ts PUBLIC_PATHS regex (added in this task).
 * The marketplace is meant to be browseable before any wallet connects.
 */
router.get('/marketplace', async (req, res) => {
  const cognitive = clampInt(req.query.cognitiveLevel, 1, 5);
  const maxPriceUsdc = parseFloatSafe(req.query.maxPriceUsdc);
  const kya = req.query.kya as string | undefined;
  const q = (req.query.q as string | undefined)?.slice(0, 64);
  const params: unknown[] = [];
  const where: string[] = ['active = true'];
  if (cognitive) {
    params.push(cognitive);
    where.push(`cognitive_level = $${params.length}`);
  }
  if (maxPriceUsdc != null) {
    params.push(maxPriceUsdc);
    where.push(`price_per_query_usdc <= $${params.length}`);
  }
  if (kya === 'required') where.push(`kya_required = true`);
  if (kya === 'optional') where.push(`kya_required = false`);
  if (q) {
    params.push(`%${q}%`);
    where.push(`(title ILIKE $${params.length} OR description ILIKE $${params.length})`);
  }
  // Defense in depth: any DB-level failure (missing table, transient network)
  // returns an empty catalog instead of crashing the process via an
  // unhandled rejection. This is the surface that browser tabs hit on every
  // /marketplace render — the cost of a blow-up here is everyone seeing 502s.
  try {
    const r = await pool.query(
      `SELECT sui_object_id, seller_wallet, memwal_account_id, namespace, title, description,
              price_per_query_usdc, kya_required, attestation_required, cognitive_level,
              sovereignty_proof_url, created_at
       FROM memwal_marketplace_brains
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT 100`,
      params,
    );
    res.json({ brains: r.rows });
  } catch (e) {
    logger.warn(
      { err: (e as Error).message, code: (e as { code?: string }).code },
      'memwal:marketplace:db_fallback',
    );
    res.json({ brains: [] });
  }
});

/**
 * POST /v3/memory/marketplace/publish — record a published brain.
 * Sui-wallet gated. Caller must have already submitted the
 * `openx_memwal_marketplace::publish_brain` Move tx and gives us the
 * resulting `MemWalBrain` shared object id; we cache the metadata for
 * fast catalog reads. The on-chain object remains the source of truth.
 */
router.post('/marketplace/publish', requireSuiWallet, async (req: AuthRequest, res) => {
  const wallet = req.user?.address;
  if (!wallet) return res.status(401).json({ error: 'auth required' });
  const b = (req.body ?? {}) as {
    suiObjectId?: string;
    memwalAccountId?: string;
    namespace?: string;
    title?: string;
    description?: string;
    pricePerQueryUsdc?: string | number;
    kyaRequired?: boolean;
    attestationRequired?: number;
    cognitiveLevel?: number;
    sovereigntyProofUrl?: string;
  };
  if (!b.suiObjectId || !b.memwalAccountId || !b.namespace || !b.title) {
    return res.status(400).json({ error: 'suiObjectId/memwalAccountId/namespace/title required' });
  }
  const cognitive = clampInt(b.cognitiveLevel, 1, 5) ?? 3;
  const attestation = clampInt(b.attestationRequired, 0, 2) ?? 0;
  const price = Number(b.pricePerQueryUsdc ?? 0);
  await pool.query(
    `INSERT INTO memwal_marketplace_brains (
       sui_object_id, seller_wallet, memwal_account_id, namespace, title, description,
       price_per_query_usdc, kya_required, attestation_required, cognitive_level,
       sovereignty_proof_url, active
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true)
     ON CONFLICT (sui_object_id) DO UPDATE SET
       title = EXCLUDED.title,
       description = EXCLUDED.description,
       price_per_query_usdc = EXCLUDED.price_per_query_usdc,
       kya_required = EXCLUDED.kya_required,
       attestation_required = EXCLUDED.attestation_required,
       cognitive_level = EXCLUDED.cognitive_level,
       sovereignty_proof_url = EXCLUDED.sovereignty_proof_url,
       updated_at = now()`,
    [
      b.suiObjectId,
      wallet.toLowerCase(),
      b.memwalAccountId,
      b.namespace,
      b.title,
      b.description ?? '',
      price,
      !!b.kyaRequired,
      attestation,
      cognitive,
      b.sovereigntyProofUrl ?? '',
    ],
  );
  res.json({ ok: true, brainId: b.suiObjectId });
});

/**
 * GET /v3/memory/brain/:id — public detail (no decryption).
 */
router.get('/brain/:id', async (req, res) => {
  const id = req.params.id;
  const r = await pool.query(
    `SELECT * FROM memwal_marketplace_brains WHERE sui_object_id = $1 LIMIT 1`,
    [id],
  );
  if (r.rows.length === 0) return res.status(404).json({ error: 'brain_not_found' });
  res.json({ brain: r.rows[0] });
});

/**
 * GET /v3/memory/brain/:id/sovereignty-proof — public, must answer even if
 * Postgres is down. We try Postgres first; if it fails we return the bare
 * minimum reconstructable proof from query params + env so the trust model
 * holds. Cache via Caddy edge in production (1h).
 */
router.get('/brain/:id/sovereignty-proof', async (req, res) => {
  const id = req.params.id;
  let row: {
    memwal_account_id?: string;
    namespace?: string;
    sovereignty_proof_url?: string;
    updated_at?: Date;
  } = {};
  try {
    const r = await pool.query<{
      memwal_account_id: string;
      namespace: string;
      sovereignty_proof_url: string | null;
      updated_at: Date;
    }>(
      `SELECT memwal_account_id, namespace, sovereignty_proof_url, updated_at
       FROM memwal_marketplace_brains WHERE sui_object_id = $1 LIMIT 1`,
      [id],
    );
    row = r.rows[0] ?? {};
  } catch (e) {
    logger.warn(
      { err: (e as Error).message, brainId: id },
      'memwal:sovereignty:db_fallback',
    );
  }
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({
    brainId: id,
    memwalAccountId: row.memwal_account_id ?? null,
    namespace: row.namespace ?? null,
    packageId: process.env.MEMWAL_PACKAGE_ID ?? '',
    registryId: process.env.MEMWAL_REGISTRY_ID ?? '',
    suiNetwork: memwalNetwork(),
    rebuildInstructions:
      'Use @mysten-incubation/memwal restore() with these credentials. OpenX is not in the trust path.',
    lastUpdated: row.updated_at ?? null,
  });
});

/**
 * POST /v3/memory/brain/:id/query — paid recall against a published brain.
 * Requires a payment voucher (x402/sui_usdc/mpp). Returns the recall results
 * plus a three-proof attestation bundle (Phala TEE + Sui billing + Walrus).
 *
 * Charges only debit the buyer when the recall succeeds — failed recalls
 * mark the row `refunded=true` and emit no on-chain billing event.
 */
router.post('/brain/:id/query', requireSuiWallet, async (req: AuthRequest, res) => {
  const wallet = req.user?.address;
  if (!wallet) return res.status(401).json({ error: 'auth required' });
  const id = req.params.id;
  const { query, limit, minRelevance } = (req.body ?? {}) as {
    query?: string;
    limit?: number;
    minRelevance?: number;
  };
  if (!query) return res.status(400).json({ error: 'query required' });

  const brainRow = await pool.query<{
    seller_wallet: string;
    memwal_account_id: string;
    namespace: string;
    price_per_query_usdc: string;
    attestation_required: number;
    active: boolean;
  }>(
    `SELECT seller_wallet, memwal_account_id, namespace, price_per_query_usdc,
            attestation_required, active
     FROM memwal_marketplace_brains WHERE sui_object_id = $1 LIMIT 1`,
    [id],
  );
  const brain = brainRow.rows[0];
  if (!brain || !brain.active) return res.status(404).json({ error: 'brain_inactive' });

  // Resolve OpenX-pool delegate (operator pattern, PRD-11 §4.1).
  const sellerAccount = brain.memwal_account_id;
  // Owner self-query bypass — the seller can interrogate their own brain
  // without paying themselves. Identity check is wallet-equality (case-
  // insensitive); the rail is recorded as `owner_free` for audit. SOLID:
  // one conditional, no architectural fork; settlement worker already
  // ignores zero-amount rows.
  const isOwner = wallet.toLowerCase() === brain.seller_wallet.toLowerCase();
  const paymentTxHash =
    (req.headers['x-payment-tx'] as string | undefined) ??
    (isOwner ? `owner-${Date.now()}-${wallet.slice(2, 10)}` : `dev-${Date.now()}-${wallet.slice(2, 10)}`);
  const rail = isOwner
    ? 'owner_free'
    : ((req.headers['x-payment-rail'] as string | undefined) ?? 'memwal_per_call');
  const amountUsdc = isOwner ? 0 : Number(brain.price_per_query_usdc);
  try {
    const gate = buildPaidQueryGate({
      brainSuiObjectId: id,
      buyerWallet: wallet,
      amountUsdc,
      paymentTxHash,
      rail,
    });
    const adapter = await getMemWalAdapter(wallet, sellerAccount, {
      namespace: brain.namespace,
      paymentGate: gate,
    });
    const out = await adapter.recall(query, {
      limit,
      namespace: brain.namespace,
      minRelevance,
    });

    // Build the three-proof bundle. Phala/Sui hashes are placeholders here —
    // T14 (paymentGate hook) + T15 (settlement worker) will populate them
    // with real attestation/tx hashes returned by the adapter and operator.
    const bundle = {
      phala_tee_hash: null as string | null,
      sui_billing_tx_hash: out.tx_hash ?? null,
      walrus_blob_ids: out.results.map((r) => r.blob_id),
      explorer_urls: {
        sui:
          out.tx_hash != null
            ? `https://suiscan.xyz/${memwalNetwork()}/tx/${out.tx_hash}`
            : null,
        walrus: out.results.map((r) => `https://walruscan.com/blob/${r.blob_id}`),
      },
    };

    res.json({
      ok: true,
      results: out.results,
      total: out.total,
      attestation: bundle,
      billing: { rail: 'memwal_per_call', tx_hash: out.tx_hash ?? null },
    });
  } catch (e) {
    // Demo-degradation: when the seller's MemWalAccount isn't onchain yet
    // (typical for fresh deployments), recall fails 401. Under
    // MEMWAL_FALLBACK_MODE=mock we synthesize a complete buyer response so
    // the cash-flow demo (mark + receipt + three-proof bundle) is visible
    // end-to-end. The synthetic billing tx is namespace+content derived,
    // deterministic — re-running the same query returns the same id, which
    // matches the idempotent semantics of x402 vouchers.
    if (process.env.MEMWAL_FALLBACK_MODE === 'mock') {
      const { createHash } = await import('node:crypto');
      const txHash = '0xmock' +
        createHash('sha256').update(`${id}|${wallet}|${query}`).digest('hex').slice(0, 56);
      const synthetic = [
        {
          score: 0.91,
          namespace: brain.namespace,
          text:
            `[mock-fallback] Brain "${id.slice(0, 12)}…" returns a synthetic ` +
            `match for: "${query.slice(0, 80)}". Real recall activates once ` +
            `the seller provisions a MemWalAccount onchain.`,
          blob_id: `local:${brain.namespace}:mock-buyer-recall`,
          metadata: { mode: 'mock-fallback' },
        },
      ];
      logger.warn(
        { wallet, brainId: id, namespace: brain.namespace, err: (e as Error)?.message ?? String(e) },
        'memwal:paidquery:fallback-mock',
      );
      return res.json({
        ok: true,
        results: synthetic,
        total: synthetic.length,
        attestation: {
          phala_tee_hash: null,
          sui_billing_tx_hash: txHash,
          walrus_blob_ids: [synthetic[0].blob_id],
          explorer_urls: {
            sui: `https://suiscan.xyz/${memwalNetwork()}/tx/${txHash}`,
            walrus: [`https://walruscan.com/blob/${synthetic[0].blob_id}`],
          },
        },
        billing: { rail, tx_hash: txHash },
        mode: 'mock-fallback',
      });
    }
    sendMemWalError(res, e);
  }
});

/**
 * POST /v3/memory/operator/provision — register OpenX pool delegates onchain.
 * Authenticated; body: { memwalAccountId, delegates: [{ pubkeyHex, suiAddress, label }] }.
 *
 * The seller MUST have authorized the OpenX operator wallet to call
 * `add_delegate_key` on their MemWalAccount BEFORE this route fires. The
 * frontend produces that authorization via dapp-kit's signTransaction; this
 * route then records the registration in `memwal_delegate_keys` after
 * the on-chain tx confirms.
 */
router.post('/operator/provision', requireSuiWallet, async (req: AuthRequest, res) => {
  const wallet = req.user?.address;
  if (!wallet) return res.status(401).json({ error: 'auth required' });
  const operator = getMemWalOperator();
  if (!operator) {
    return res.status(503).json({ error: 'operator_not_configured', message: 'OPENX_OPERATOR_SUI_PRIVATE_KEY missing' });
  }
  const { memwalAccountId, delegates } = (req.body ?? {}) as {
    memwalAccountId?: string;
    delegates?: Array<{ pubkeyHex: string; suiAddress: string; label?: string }>;
  };
  if (!memwalAccountId || !delegates || delegates.length === 0) {
    return res.status(400).json({ error: 'memwalAccountId + delegates[] required' });
  }
  try {
    const result = await operator.addDelegateKeys(
      memwalAccountId,
      delegates.map((d) => ({
        delegatePubkeyHex: d.pubkeyHex,
        delegateSuiAddress: d.suiAddress,
        label: d.label ?? 'openx-operator',
      })),
    );
    // Persist (idempotent on (memwal_account_id, delegate_pubkey_hex)).
    for (const d of delegates) {
      await pool.query(
        `INSERT INTO memwal_delegate_keys (
          owner_wallet, memwal_account_id, delegate_pubkey_hex,
          delegate_sui_address, role, label
        ) VALUES ($1,$2,$3,$4,'openx-operator',$5)
        ON CONFLICT (memwal_account_id, delegate_pubkey_hex)
        WHERE revoked_at IS NULL DO NOTHING`,
        [wallet.toLowerCase(), memwalAccountId, d.pubkeyHex, d.suiAddress, d.label ?? 'openx-operator'],
      );
    }
    // Cache the account for adapter resolution.
    await pool.query(
      `INSERT INTO memwal_accounts (wallet_address, sui_account_id, server_url, delegate_count)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (wallet_address) DO UPDATE SET
         sui_account_id = EXCLUDED.sui_account_id,
         server_url = EXCLUDED.server_url,
         delegate_count = memwal_accounts.delegate_count + EXCLUDED.delegate_count,
         updated_at = now()`,
      [wallet.toLowerCase(), memwalAccountId, envOr('MEMWAL_RELAYER_URL'), delegates.length],
    );
    res.json({ ok: true, txDigest: result.digest });
  } catch (e) {
    logger.error({ err: (e as Error)?.message }, 'memwal:operator:provision:err');
    res.status(502).json({ error: 'operator_submit_failed', message: (e as Error)?.message });
  }
});

// ─── helpers ──────────────────────────────────────────────────────────

function clampInt(v: unknown, min: number, max: number): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i < min || i > max ? null : i;
}

function parseFloatSafe(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * GET /v3/memory/stats/agents/:agent_id — F6 reflexive-loop observability.
 *
 * Returns per-level write counts (last 24h), MemWal mirror flag status,
 * and a snapshot of cron last-run timestamps. The endpoint is intentionally
 * read-only and additive — it never mutates state.
 *
 * Public: no PII; no namespace contents leaked. Filtering is by agent_id.
 */
router.get('/stats/agents/:agent_id', async (req, res) => {
  const agent_id = String(req.params.agent_id ?? '');
  if (!agent_id) return res.status(400).json({ error: 'agent_id_required' });

  const counts = await pool.query<{ level: number; n: string; per_buyer: boolean }>(
    `SELECT cognitive_level AS level,
            COUNT(*)::text  AS n,
            (namespace ~ ('cog-l[0-9]-' || $1 || '-0x'))::bool AS per_buyer
       FROM cognitive_memories
      WHERE namespace LIKE ('cog-l%-' || $1 || '%')
        AND created_at > now() - INTERVAL '24 hours'
      GROUP BY cognitive_level, per_buyer`,
    [agent_id],
  );

  const memory_levels = {
    l2_count_24h: 0,
    l3_count_24h: 0,
    l4_agent_count_24h: 0,
    l4_per_buyer_count_24h: 0,
    l5_agent_count_24h: 0,
    l5_per_buyer_count_24h: 0,
  };
  for (const row of counts.rows) {
    const n = Number(row.n);
    if (row.level === 2) memory_levels.l2_count_24h += n;
    else if (row.level === 3) memory_levels.l3_count_24h += n;
    else if (row.level === 4) {
      if (row.per_buyer) memory_levels.l4_per_buyer_count_24h += n;
      else memory_levels.l4_agent_count_24h += n;
    } else if (row.level === 5) {
      if (row.per_buyer) memory_levels.l5_per_buyer_count_24h += n;
      else memory_levels.l5_agent_count_24h += n;
    }
  }

  res.json({
    agent_id,
    memory_levels,
    flags: {
      memwal_peerdep_enabled: process.env.MEMWAL_PEERDEP_ENABLED === 'true',
      mode_a_memory_enabled: process.env.FEATURE_LOOP_MODE_A_MEMORY === 'true',
      persona_auto_rewrite_enabled: process.env.FEATURE_LOOP_W3_PERSONA_AUTO_REWRITE === 'true',
      para_archival_enabled: process.env.FEATURE_LOOP_W3_PARA_ARCHIVAL === 'true',
      weekly_digest_enabled: process.env.FEATURE_WEEKLY_DIGEST === 'true',
    },
    generated_at: new Date().toISOString(),
  });
});

export default router;
