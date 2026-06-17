/**
 * middleware/agentX402.ts — slug-keyed Sui paywall for `/v3/agents/:slug/try`
 * and `/api/v1/:slug`.
 *
 * Domain: a published `agents` row points at a `MemWalBrain` and carries a
 * per-call USDC price in `pricing.sui_usdc`. Settlement is a plain split of
 * a buyer-supplied `Coin<USDC>`:
 *
 *   95% → agents.owner_address  (seller revenue)
 *    5% → OPENX_PLATFORM_TREASURY  (marketplace cut)
 *
 * Two `Coin::split` calls + two `transferObjects` — no Move entry function,
 * no new contract. Receipt = the tx digest. Revenue-split refinement
 * (compute_treasury, dynamic bps) is a follow-up; this is the simplest
 * correct settlement that emits an on-chain event tied to (buyer, slug, ts).
 *
 * Plumbing (HMAC, sponsor, gas, execute) lives in `suiX402Core.ts`.
 *
 * SOLID:
 *   - SRP: load agents row, build split PTB, attach settlement to req.
 *   - DIP: imports from suiX402Core; no Sui client construction here.
 *   - OCP: switching to a Move entry function later is one PTB-builder swap.
 */

import type { Request, Response, NextFunction } from 'express';
import { Transaction } from '@mysten/sui/transactions';
import { pool } from '../db';
import { logger } from '../lib';
import {
  NETWORK,
  SuiX402Error,
  buildChallenge,
  executeWithSponsor,
  finalizeSponsoredPtb,
  getSponsor,
  getSuiClient,
  parseAndVerifyXPayment,
} from './suiX402Core';
import * as ledger from '../services/paidCallLedger';

// ─── Domain config ───────────────────────────────────────────────────────

const USDC_COIN_TYPE = process.env.OPENX_USDC_COIN_TYPE ?? '';
const PLATFORM_TREASURY = (process.env.OPENX_PLATFORM_TREASURY ?? '').toLowerCase();
const PLATFORM_BPS = Math.min(
  Math.max(Number(process.env.OPENX_PLATFORM_BPS ?? '500'), 0),
  2_000,
); // 5% default, 0..20% allowed
const FEATURE = () => process.env.FEATURE_AGENT_X402 !== 'false';

// ─── Settlement attached to req for downstream handlers ──────────────────

declare module 'express-serve-static-core' {
  interface Request {
    agentSettlement?: {
      txDigest: string;
      amountMicro: bigint;
      payer: string;
      seller: string;
      agentId: string;
      slug: string;
    };
    /** Loaded by middleware so the route handler doesn't re-query. */
    agentRow?: AgentRow;
  }
}

export interface AgentRow {
  id: string;
  slug: string;
  brain_id: number;
  owner_address: string;
  persona: { system_prompt?: string | null; tools?: string[]; description?: string } | null;
  pricing: { x402?: string | null; mpp?: string | null; sui_usdc?: string | null };
  chain: string | null;
  published: boolean;
  /** Per-agent free-tier cap (free /try calls per buyer per 24h). NULL = use env default. */
  daily_request_cap: number | null;
}

/**
 * Sui-only network gate. Migration 004 used 'sui'; migration 022 widened
 * to 'sui-testnet' + 'sui-mainnet'. Accepting all three keeps back-fills
 * + future mainnet rows reachable via the slug paywall. Any non-Sui agent
 * (arbitrum-sepolia, fhenix, base-sepolia) returns 404 from this loader,
 * which propagates to /api/v1/<slug>, /v3/agents/:slug/*, and the
 * AgentCard endpoint. One filter, six surfaces locked.
 */
const SUI_CHAINS = ['sui', 'sui-testnet', 'sui-mainnet'];

export async function loadAgentBySlug(slug: string): Promise<AgentRow | null> {
  const r = await pool.query(
    `SELECT id, slug, brain_id, owner_address, persona, pricing, chain, published, daily_request_cap
       FROM agents
      WHERE slug = $1 AND published = true AND chain = ANY($2::text[])`,
    [slug, SUI_CHAINS],
  );
  return (r.rows[0] as AgentRow | undefined) ?? null;
}

// ─── In-process per-payer rate limit (matches loopX402 shape) ────────────

const rateBucket = new Map<string, { count: number; windowStart: number }>();
const RATE_LIMIT = Number(process.env.OPENX_AGENT_X402_RATE_LIMIT_PER_HOUR ?? 200);
function checkRateLimit(payer: string): boolean {
  const now = Date.now();
  const e = rateBucket.get(payer);
  if (!e || now - e.windowStart > 3_600_000) {
    rateBucket.set(payer, { count: 1, windowStart: now });
    return true;
  }
  if (e.count >= RATE_LIMIT) return false;
  e.count += 1;
  return true;
}

// ─── PTB builder — plain Coin<USDC> 95/5 split ──────────────────────────

function microUsdcFromDecimal(decimal: string): bigint {
  const [whole, frac = ''] = decimal.split('.');
  const padded = (frac + '000000').slice(0, 6);
  return BigInt(whole) * 1_000_000n + BigInt(padded || '0');
}

function buildSplitPtb(args: {
  paymentCoinObjectId: string;
  totalMicro: bigint;
  sellerAddress: string;
  platformAddress: string;
  platformBps: number;
}): Transaction {
  const tx = new Transaction();
  const platformCut = (args.totalMicro * BigInt(args.platformBps)) / 10_000n;
  const sellerCut = args.totalMicro - platformCut;

  // Two Coin::split calls + two transferObjects. The remainder coin (the
  // original payment input after both splits) carries the seller cut.
  const platformCoin = tx.splitCoins(tx.object(args.paymentCoinObjectId), [tx.pure.u64(platformCut)]);
  tx.transferObjects([platformCoin], tx.pure.address(args.platformAddress));
  // Seller takes whatever remains.
  tx.transferObjects([tx.object(args.paymentCoinObjectId)], tx.pure.address(args.sellerAddress));
  return tx;
}

// ─── Middleware factory ──────────────────────────────────────────────────

export function agentX402Middleware() {
  return async function agentX402(req: Request, res: Response, next: NextFunction) {
    // SOLID: error handling is now centralized in `lib/routerSafety.ts` —
    // any throw in this middleware (sponsor_gas_empty, missing sponsor key,
    // pg errors, etc.) bubbles to the global errorHandler that maps it
    // to a clean 503/4xx. The explicit env-presence checks below short-
    // circuit BEFORE we touch the sponsor signer, so the most common
    // misconfigurations return readable detail strings without throwing.
    if (!FEATURE()) return res.status(404).json({ error: 'agent_x402_disabled' });
    if (!USDC_COIN_TYPE) {
      return res.status(503).json({
        error: 'agent_x402_unconfigured',
        detail: 'set OPENX_USDC_COIN_TYPE',
      });
    }
    if (!PLATFORM_TREASURY || !PLATFORM_TREASURY.startsWith('0x')) {
      return res.status(503).json({
        error: 'agent_x402_unconfigured',
        detail: 'set OPENX_PLATFORM_TREASURY (Sui address)',
      });
    }
    if (!process.env.OPENX_LOOP_SPONSOR_PRIVATE_KEY) {
      return res.status(503).json({
        error: 'agent_x402_unconfigured',
        detail: 'set OPENX_LOOP_SPONSOR_PRIVATE_KEY (sponsor wallet that pays gas for buyer-signed PTBs)',
      });
    }

    const slug = String(req.params.slug ?? req.params.id ?? '');
    if (!slug) return res.status(400).json({ error: 'slug_required' });

    const agent = req.agentRow ?? (await loadAgentBySlug(slug));
    if (!agent) return res.status(404).json({ error: 'agent_not_found' });
    req.agentRow = agent;

    const priceDecimal = agent.pricing?.sui_usdc ?? agent.pricing?.x402 ?? null;
    if (!priceDecimal || Number(priceDecimal) <= 0) {
      return res.status(503).json({ error: 'agent_not_priced', detail: 'pricing.sui_usdc not set' });
    }
    const amountMicro = microUsdcFromDecimal(priceDecimal);

    const buyer = String(req.header('X-Buyer-Address') ?? req.body?.buyer_address ?? '').toLowerCase();
    if (!buyer || !buyer.startsWith('0x')) {
      return res.status(400).json({ error: 'buyer_address_required' });
    }
    if (!checkRateLimit(buyer)) return res.status(429).json({ error: 'rate_limit' });

    // ── Self-settled path: buyer signed + executed their own PTB and just
    //    sent us the digest. No sponsor key, no gas paid by us. We verify
    //    on-chain via Sui RPC that the buyer actually paid the seller (and
    //    optional platform treasury) the right USDC amount, then proceed.
    //    SOLID: shortcut path; sponsored flow below stays intact for MCP.
    const settledTxDigest = String(req.body?.settled_tx_digest ?? '');
    if (settledTxDigest) {
      let tx;
      try {
        // waitForTransaction polls until the tx is committed on the RPC the
        // server hits (vs getTransactionBlock which fails immediately on
        // "not found" before the public testnet RPC has propagated the tx
        // the buyer just signed). Timeout kept short so a stuck submission
        // returns 400 fast rather than hanging the request.
        tx = await getSuiClient().waitForTransaction({
          digest: settledTxDigest,
          options: { showEffects: true, showBalanceChanges: true, showInput: true },
          timeout: 15_000,
          pollInterval: 500,
        });
      } catch (e) {
        // Bad digest format / not-found-within-timeout / RPC error → 400.
        return res.status(400).json({ error: 'invalid_tx_digest', detail: (e as Error)?.message ?? 'cannot fetch tx' });
      }
      if (!tx || tx.effects?.status?.status !== 'success') {
        return res.status(400).json({ error: 'tx_not_successful', detail: tx?.effects?.status?.error });
      }
      const txSender = String(tx.transaction?.data?.sender ?? '').toLowerCase();
      if (txSender !== buyer) {
        return res.status(400).json({ error: 'tx_sender_mismatch', expected: buyer, actual: txSender });
      }
      const ageMs = Date.now() - Number(tx.timestampMs ?? 0);
      if (ageMs > 10 * 60 * 1000) {
        return res.status(400).json({ error: 'tx_too_old', detail: `${Math.round(ageMs / 1000)}s old; max 600s` });
      }
      // Verify USDC balance changes match the expected splits.
      // Edge case: if buyer == seller (e.g., seller testing their own agent),
      // the seller's net balance change will be 0 because they paid themselves.
      // In that case, only enforce the platform cut. Otherwise enforce both.
      const sellerCutMicro = (amountMicro * BigInt(10_000 - PLATFORM_BPS)) / 10_000n;
      const platformCutMicro = amountMicro - sellerCutMicro;
      const findIncrement = (target: string): bigint => {
        const t = target.toLowerCase();
        for (const bc of tx.balanceChanges ?? []) {
          if (bc.coinType !== USDC_COIN_TYPE) continue;
          const owner = bc.owner as { AddressOwner?: string } | string;
          const ownerAddr = typeof owner === 'object' && owner.AddressOwner ? owner.AddressOwner.toLowerCase() : '';
          if (ownerAddr === t) return BigInt(bc.amount);
        }
        return 0n;
      };
      const buyerIsSeller = buyer === agent.owner_address.toLowerCase();
      if (!buyerIsSeller) {
        const sellerGot = findIncrement(agent.owner_address);
        if (sellerGot < sellerCutMicro) {
          return res.status(400).json({
            error: 'seller_underpaid',
            detail: `seller received ${sellerGot} micro USDC; expected ≥ ${sellerCutMicro}`,
          });
        }
      }
      if (PLATFORM_TREASURY && platformCutMicro > 0n) {
        const platformIsBuyer = buyer === PLATFORM_TREASURY.toLowerCase();
        if (!platformIsBuyer) {
          const platformGot = findIncrement(PLATFORM_TREASURY);
          if (platformGot < platformCutMicro) {
            return res.status(400).json({
              error: 'platform_underpaid',
              detail: `platform received ${platformGot} micro USDC; expected ≥ ${platformCutMicro}`,
            });
          }
        }
      }
      // In the buyer==seller (and/or buyer==platform) case, also assert that
      // the buyer actually spent USDC — at minimum the non-self portion. Net
      // change for buyer must be ≤ -(amountMicro - sumOfSelfReceived).
      const buyerNet = findIncrement(buyer);
      const expectedSpend = -amountMicro
        + (buyerIsSeller ? sellerCutMicro : 0n)
        + (PLATFORM_TREASURY && buyer === PLATFORM_TREASURY.toLowerCase() ? platformCutMicro : 0n);
      if (buyerNet > expectedSpend) {
        return res.status(400).json({
          error: 'buyer_underpaid',
          detail: `buyer net USDC change ${buyerNet}; expected ≤ ${expectedSpend}`,
        });
      }
      // Anti-replay: paid_calls UNIQUE(network, tx_hash) rejects duplicates.
      await ledger.record({
        agent_id: agent.id,
        slug,
        buyer,
        amount_usdc: priceDecimal,
        tx_hash: settledTxDigest,
        network: NETWORK,
        method: 'sui_usdc',
      });
      req.agentSettlement = {
        txDigest: settledTxDigest,
        amountMicro,
        payer: buyer,
        seller: agent.owner_address,
        agentId: agent.id,
        slug,
      };
      logger.info(
        { tx_digest: settledTxDigest, slug, payer: buyer, amount_usdc: priceDecimal, mode: 'self-settled' },
        'agentX402:settled',
      );
      return next();
    }

    const xPayment = req.header('X-PAYMENT');

    // ── 402 path: build sponsored split PTB and emit envelope. ──────────
    if (!xPayment) {
      const paymentCoinObjectId = String(req.body?.payment_coin_object_id ?? '');
      if (!paymentCoinObjectId) {
        return res.status(400).json({
          error: 'payment_coin_required',
          detail: 'POST { buyer_address, payment_coin_object_id }',
        });
      }
      const tx = buildSplitPtb({
        paymentCoinObjectId,
        totalMicro: amountMicro,
        sellerAddress: agent.owner_address,
        platformAddress: PLATFORM_TREASURY,
        platformBps: PLATFORM_BPS,
      });

      let finalized;
      try {
        finalized = await finalizeSponsoredPtb({ tx, buyerAddress: buyer });
      } catch (e) {
        if (e instanceof SuiX402Error && e.code === 'sponsor_gas_empty') {
          return res.status(503).json({ error: 'sponsor_gas_empty', detail: e.detail });
        }
        throw e;
      }

      const { token: challenge_id, body } = buildChallenge({
        resource: slug,
        amount: amountMicro.toString(),
        payer: buyer,
        ptb_digest_hex: finalized.ptbDigestHex,
      });

      return res.status(402).json({
        rail: 'sui_usdc',
        ptb_bytes_b64: finalized.ptbBytesB64,
        slug,
        amount_usdc: priceDecimal,
        amount_micro_usdc: amountMicro.toString(),
        pay_to: agent.owner_address,
        platform_treasury: PLATFORM_TREASURY,
        platform_bps: PLATFORM_BPS,
        asset: USDC_COIN_TYPE,
        network: NETWORK,
        resource: req.originalUrl,
        challenge_id,
        expires_at_ms: body.expires_at_ms,
      });
    }

    // ── X-PAYMENT path: parse + verify + execute via core. ──────────────
    let verified;
    try {
      verified = parseAndVerifyXPayment(xPayment, { resource: slug, payer: buyer });
    } catch (e) {
      if (e instanceof SuiX402Error) {
        return res.status(402).json({ error: e.code, code: e.code, detail: e.detail });
      }
      throw e;
    }

    let result;
    try {
      result = await executeWithSponsor({
        ptbBytesB64: verified.ptbBytesB64,
        buyerSignature: verified.buyerSignature,
      });
    } catch (e) {
      if (e instanceof SuiX402Error) {
        return res.status(402).json({ error: e.code, code: e.code, detail: e.detail });
      }
      throw e;
    }

    req.agentSettlement = {
      txDigest: result.digest,
      amountMicro: BigInt(verified.challenge.amount),
      payer: buyer,
      seller: agent.owner_address.toLowerCase(),
      agentId: agent.id,
      slug,
    };

    // Idempotent ledger row — the route handler also has visibility but
    // recording here means a crash mid-handler still leaves a paid trace.
    await ledger.record({
      agent_id: agent.id,
      slug,
      buyer,
      amount_usdc: priceDecimal,
      tx_hash: result.digest,
      network: NETWORK,
      method: 'exact',
    });

    res.setHeader(
      'X-PAYMENT-RESPONSE',
      Buffer.from(
        JSON.stringify({
          tx_digest: result.digest,
          amount_usdc: priceDecimal,
          network: NETWORK,
        }),
      ).toString('base64'),
    );

    logger.info(
      { tx_digest: result.digest, slug, payer: buyer, amount_usdc: priceDecimal },
      'agentX402:settled',
    );
    next();
  };
}

/** Convenience for tests: ensure sponsor is loadable without firing the mw. */
export function readinessCheck(): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!USDC_COIN_TYPE) missing.push('OPENX_USDC_COIN_TYPE');
  if (!PLATFORM_TREASURY) missing.push('OPENX_PLATFORM_TREASURY');
  try {
    getSponsor();
  } catch {
    missing.push('OPENX_LOOP_SPONSOR_PRIVATE_KEY (or OPENX_OPERATOR_SUI_PRIVATE_KEY)');
  }
  return { ok: missing.length === 0, missing };
}
