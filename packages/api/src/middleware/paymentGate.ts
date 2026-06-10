import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { pool } from '../db';
import type { AuthRequest } from './auth';
import { logger } from '../lib';

/**
 * paymentGate — single middleware, Sui-USDC-first.
 *
 * Emits HTTP 402 with one `WWW-Authenticate: Payment …` header per rail
 * the agent has enabled. Spec source: x402 + Stripe/Tempo MPP. The
 * envelope shape is identical for all rails — only the `method` differs.
 *
 * Mock-first verification:
 *   - Each emitted challenge_id is HMAC-signed with PAYMENT_SECRET.
 *   - The buyer retries with `Authorization: Payment <method> <challenge_id> <receipt>`.
 *   - We verify the HMAC and record an `agent_receipts` row.
 */

type Rail = 'x402' | 'mpp' | 'sui_usdc';

interface AgentPricing {
  x402: string | null;
  mpp: string | null;
  sui_usdc: string | null;
}

interface AgentRecord {
  id: string;
  brain_id: number;
  owner_address: string;
  chain: 'sui-testnet' | 'sui-mainnet';
  persona: { system_prompt: string; tools: string[]; model: string };
  pricing: AgentPricing;
  published: boolean;
  created_at: Date;
}

export interface PriceableRequest extends AuthRequest {
  pricedAgent?: AgentRecord;
  receipt?: { rail: Rail; tx_or_receipt: string; amount_usdc: string };
}

const PAYMENT_SECRET =
  process.env.PAYMENT_SECRET ?? 'dev-only-payment-secret-please-rotate';

interface ChallengeBody {
  rail: Rail;
  amount_usdc: string;
  endpoint: string;
  expires_at: number;
}

function signChallenge(body: ChallengeBody): string {
  const canonical = JSON.stringify(body);
  const sig = crypto.createHmac('sha256', PAYMENT_SECRET).update(canonical).digest('base64url');
  return `${Buffer.from(canonical).toString('base64url')}.${sig}`;
}

function verifyChallenge(token: string): ChallengeBody | null {
  try {
    const [bodyB64, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', PAYMENT_SECRET).update(Buffer.from(bodyB64, 'base64url')).digest('base64url');
    if (sig !== expected) return null;
    const body: ChallengeBody = JSON.parse(Buffer.from(bodyB64, 'base64url').toString('utf8'));
    if (body.expires_at < Date.now()) return null;
    return body;
  } catch {
    return null;
  }
}

const RAIL_TO_METHOD: Record<Rail, string> = {
  x402: 'exact',
  mpp: 'tempo',
  sui_usdc: 'sui-usdc',
};

function emit402(res: Response, agent: AgentRecord, endpoint: string): void {
  const headers: string[] = [];
  const expires_at = Date.now() + 5 * 60 * 1000;
  const offers: { rail: Rail; amount: string }[] = [];

  for (const rail of ['sui_usdc', 'x402', 'mpp'] as Rail[]) {
    const amount = agent.pricing[rail];
    if (!amount || amount === '0') continue;
    const id = signChallenge({ rail, amount_usdc: amount, endpoint, expires_at });
    headers.push(
      `Payment id="${id}", method="${RAIL_TO_METHOD[rail]}", currency="USDC", amount="${amount}"`,
    );
    offers.push({ rail, amount });
  }

  if (headers.length === 0) return; // free agent — fall through

  for (const h of headers) res.append('WWW-Authenticate', h);
  res.status(402).type('application/problem+json').json({
    type: 'https://paymentauth.org/problems/payment-required',
    title: 'Payment Required',
    status: 402,
    detail: 'Payment required to invoke this agent.',
    rails: offers,
  });
}

export async function paymentGate(req: PriceableRequest, res: Response, next: NextFunction) {
  const agentId = req.params.id ?? req.params.agentId;
  if (!agentId) return res.status(400).json({ error: 'agent id required' });

  const r = await pool.query(
    `SELECT id, brain_id, owner_address, chain, persona, pricing, published, created_at
       FROM agents WHERE id = $1 AND published = true`,
    [agentId],
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'agent not found' });
  const agent = r.rows[0] as AgentRecord;
  req.pricedAgent = agent;

  const authHeader = req.headers.authorization ?? '';
  if (!authHeader.startsWith('Payment ')) return emit402(res, agent, req.originalUrl);

  const [, method, challengeId, receipt] = authHeader.split(/\s+/);
  const body = verifyChallenge(challengeId ?? '');
  if (!body) return emit402(res, agent, req.originalUrl);
  if (method !== RAIL_TO_METHOD[body.rail]) return emit402(res, agent, req.originalUrl);
  if (!receipt || receipt.length < 4) return emit402(res, agent, req.originalUrl);

  await pool.query(
    `INSERT INTO agent_receipts (agent_id, buyer, rail, amount_usdc, tx_or_receipt, bundle_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      agent.id,
      req.user?.address ?? 'anonymous',
      body.rail,
      body.amount_usdc,
      receipt,
      (req.headers['x-bundle-id'] as string | undefined) ?? null,
    ],
  );
  req.receipt = { rail: body.rail, tx_or_receipt: receipt, amount_usdc: body.amount_usdc };
  logger.info({ agentId: agent.id, rail: body.rail, amount: body.amount_usdc }, 'paymentGate:receipt');
  next();
}
