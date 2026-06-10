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

import { Router, Request, Response } from 'express';
import { pool } from '../db';
import { logger } from '../lib';
import type { AuthRequest } from '../middleware/auth';
import { publish, type SellerPublishInput } from '../services/sellerPublishService';

const router = Router();

const VALID_DOMAINS = new Set([
  'marketing', 'finance', 'research', 'engineering', 'generalist', 'other',
]);
const VALID_TIERS = new Set(['basic', 'verified', 'tee_attested']);

// ─── Public catalog ────────────────────────────────────────────────────────

router.get('/listings', async (req: Request, res: Response) => {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 100);
  const offset = Math.max(Number(req.query.offset ?? 0), 0);
  const domain = typeof req.query.domain === 'string' && VALID_DOMAINS.has(req.query.domain) ? req.query.domain : null;
  const tier = typeof req.query.tier === 'string' && VALID_TIERS.has(req.query.tier) ? req.query.tier : null;

  const params: Array<string | number> = [limit, offset];
  let where = `WHERE a.published = true`;
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
        WHERE a.seller_id = $1
     GROUP BY a.id
     ORDER BY a.created_at DESC`,
      [sellerId],
    ),
    pool.query(
      `SELECT
         COALESCE(SUM(pc.amount_usdc) FILTER (WHERE pc.created_at > now() - interval '7 days'), 0)::text  AS last_7d,
         COALESCE(SUM(pc.amount_usdc) FILTER (WHERE pc.created_at > now() - interval '30 days'), 0)::text AS last_30d,
         COALESCE(SUM(pc.amount_usdc), 0)::text                                                            AS all_time,
         COUNT(*) FILTER (WHERE pc.created_at > now() - interval '7 days')                                 AS calls_7d
       FROM paid_calls pc
       JOIN agents a ON a.id = pc.agent_id
      WHERE a.seller_id = $1`,
      [sellerId],
    ),
  ]);

  res.json({
    seller_id: sellerId,
    agents: agents.rows,
    earnings: earnings.rows[0] ?? { last_7d: '0', last_30d: '0', all_time: '0', calls_7d: 0 },
  });
});

export default router;
