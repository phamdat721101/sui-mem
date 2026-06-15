/**
 * middleware/loopX402.ts — Sui-native x402 fast-lane gating for Loop jobs.
 *
 * Domain: Loop jobs keyed by Loop `Agent` shared object id. Each settle calls
 * `openx_loop_x402_router::settle_and_distribute<USDC>` which fans payment
 * to (seller, compute_treasury, platform_treasury) atomically.
 *
 * Plumbing (HMAC challenge, sponsor co-sign, gas-coin pick, execute, error
 * mapping) lives in `suiX402Core.ts` so this file is purely the Loop-domain
 * loader + price gate. The agent-paywall sibling (`agentX402.ts`) reuses the
 * same core — no duplication.
 *
 * SOLID:
 *   - SRP: this module owns "Loop-Agent → 402 envelope → settle". No HMAC,
 *     no sponsor key handling, no Sui client construction.
 *   - DIP: core primitives are imported, not re-implemented.
 */

import type { Request, Response, NextFunction } from 'express';
import { type SuiObjectResponse } from '@mysten/sui/client';
import { buildSettleAndDistributePtb } from '@fhe-ai-context/sdk';
import { logger } from '../lib';
import {
  NETWORK,
  SuiX402Error,
  buildChallenge,
  executeWithSponsor,
  finalizeSponsoredPtb,
  getSuiClient,
  parseAndVerifyXPayment,
} from './suiX402Core';

// ─── Domain config ───────────────────────────────────────────────────────

const PACKAGE_ID = process.env.OPENX_BRAIN_PACKAGE_ID ?? '';
const X402_ROUTER_CONFIG_ID = process.env.OPENX_LOOP_X402_ROUTER_CONFIG_ID ?? '';
const USDC_COIN_TYPE = process.env.OPENX_USDC_COIN_TYPE ?? '';
const FEATURE = () => process.env.FEATURE_LOOP_X402 !== 'false';

// ─── In-process per-payer rate limit (unchanged) ─────────────────────────

const rateBucket = new Map<string, { count: number; windowStart: number }>();
const RATE_LIMIT = Number(process.env.OPENX_LOOP_X402_RATE_LIMIT_PER_HOUR ?? 100);
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

// ─── Settlement attached to req for downstream handlers ──────────────────

declare module 'express-serve-static-core' {
  interface Request {
    loopX402Settlement?: {
      txDigest: string;
      amountMicro: bigint;
      payer: string;
      seller: string;
      agentObjectId: string;
    };
  }
}

// ─── Loop Agent loader ───────────────────────────────────────────────────

interface LoopAgentSummary {
  agentObjectId: string;
  seller: string;
  perIterDefaultMicro: bigint;
  manifestWalrusBlobId: string;
  revoked: boolean;
}

async function readLoopAgent(agentObjectId: string): Promise<LoopAgentSummary | null> {
  const res: SuiObjectResponse = await getSuiClient().getObject({
    id: agentObjectId,
    options: { showContent: true },
  });
  const content = res.data?.content;
  if (!content || content.dataType !== 'moveObject') return null;
  const f = (content.fields as Record<string, unknown>) ?? {};
  return {
    agentObjectId,
    seller: String(f.seller ?? ''),
    perIterDefaultMicro: BigInt((f.per_iter_default_micro_usdc as string | undefined) ?? '0'),
    manifestWalrusBlobId: String(f.manifest_walrus_blob_id ?? ''),
    revoked: Boolean(f.revoked ?? false),
  };
}

// ─── Middleware factory ──────────────────────────────────────────────────

export function loopX402Middleware() {
  return async function loopX402(req: Request, res: Response, next: NextFunction) {
    if (!FEATURE()) return res.status(404).json({ error: 'loop_x402_disabled' });
    if (!PACKAGE_ID || !X402_ROUTER_CONFIG_ID || !USDC_COIN_TYPE) {
      return res
        .status(503)
        .json({ error: 'loop_x402_unconfigured', detail: 'set OPENX_BRAIN_PACKAGE_ID, OPENX_LOOP_X402_ROUTER_CONFIG_ID, OPENX_USDC_COIN_TYPE' });
    }

    const agentId = String(req.params.agentId ?? req.params.id ?? '');
    if (!agentId) return res.status(400).json({ error: 'agent_id_required' });

    const agent = await readLoopAgent(agentId);
    if (!agent) return res.status(404).json({ error: 'agent_not_found' });
    if (agent.revoked) return res.status(410).json({ error: 'agent_revoked' });

    const xPayment = req.header('X-PAYMENT');
    const buyer = String(req.header('X-Buyer-Address') ?? req.body?.buyer_address ?? '').toLowerCase();
    if (!buyer || !buyer.startsWith('0x')) return res.status(400).json({ error: 'buyer_address_required' });
    if (!checkRateLimit(buyer)) return res.status(429).json({ error: 'rate_limit' });

    // ── 402 path: build unsigned sponsored-tx PTB and emit envelope. ─────
    if (!xPayment) {
      const paymentCoinObjectId = String(req.body?.payment_coin_object_id ?? '');
      if (!paymentCoinObjectId) {
        return res.status(400).json({
          error: 'payment_coin_required',
          detail: 'POST with body { buyer_address, payment_coin_object_id }',
        });
      }
      const tx = buildSettleAndDistributePtb({
        packageId: PACKAGE_ID,
        routerConfigObjectId: X402_ROUTER_CONFIG_ID,
        agentObjectId: agentId,
        paymentCoinObjectId,
        usdcCoinType: USDC_COIN_TYPE,
        buyerAddress: buyer,
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

      const { token: challenge_id } = buildChallenge({
        resource: agentId,
        amount: agent.perIterDefaultMicro.toString(),
        payer: buyer,
        ptb_digest_hex: finalized.ptbDigestHex,
      });

      return res.status(402).json({
        ptb_bytes_b64: finalized.ptbBytesB64,
        agent_object_id: agentId,
        amount_micro_usdc: agent.perIterDefaultMicro.toString(),
        manifest_walrus_blob_id: agent.manifestWalrusBlobId,
        network: NETWORK,
        resource: req.originalUrl,
        challenge_id,
        expires_at_ms: Date.now() + 5 * 60_000,
      });
    }

    // ── X-PAYMENT path: parse + verify + execute via core. ──────────────
    let verified;
    try {
      verified = parseAndVerifyXPayment(xPayment, { resource: agentId, payer: buyer });
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

    req.loopX402Settlement = {
      txDigest: result.digest,
      amountMicro: BigInt(verified.challenge.amount),
      payer: buyer,
      seller: agent.seller.toLowerCase(),
      agentObjectId: agentId,
    };

    res.setHeader(
      'X-PAYMENT-RESPONSE',
      Buffer.from(
        JSON.stringify({
          tx_digest: result.digest,
          amount_micro_usdc: verified.challenge.amount,
          network: NETWORK,
        }),
      ).toString('base64'),
    );

    logger.info(
      { tx_digest: result.digest, agent_id: agentId, payer: buyer, amount: verified.challenge.amount },
      'loopX402:settled',
    );
    next();
  };
}
