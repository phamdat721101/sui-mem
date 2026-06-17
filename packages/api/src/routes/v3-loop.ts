/**
 * routes/v3-loop — single Express router for the OpenX Loops product.
 *
 * Surface:
 *   GET  /v3/loop/version
 *   GET  /v3/loop/agents/:id                       on-chain Agent + manifest
 *   POST /v3/loop/agents/:id/invoke                Mode A: x402 → invoke
 *   POST /v3/loop/seller/publish                   sponsored publish PTB
 *   POST /v3/loop/jobs/create                      Mode B: sponsored hire PTB
 *   GET  /v3/loop/jobs/:objectId                   on-chain LoopJob
 *   POST /v3/loop/concierge/search                 chat-driven discovery
 *
 * SOLID:
 *   - SRP: HTTP plumbing only. Inference + discovery + sponsored-tx live in
 *     `services/loop/*` and `middleware/loopX402.ts`.
 *   - DIP: SuiClient + sponsor keypair are constructed once via env (mirrors
 *     `middleware/loopX402.ts` — same singleton pattern).
 *
 * MemWal-first (Q5=b): seller publish writes to the `openx-loop-agent-index`
 * namespace synchronously after the on-chain commit. No new Postgres tables.
 */

import { type Request, type Response } from 'express';
import { hardenedRouter } from '../lib/routerSafety';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';
import {
  buildPublishAgentPtb,
  buildCreateJobPtb,
} from '@fhe-ai-context/sdk';
import { LoopAgentInvoker } from '../services/loop/agentInvoker';
import {
  conciergeSearch,
  indexLoopAgent,
  type LoopAgentIndexRecord,
} from '../services/loop/conciergeService';
import { loopX402Middleware } from '../middleware/loopX402';
import type { AuthRequest } from '../middleware/auth';
import { logger } from '../lib';

const router = hardenedRouter();

// ─── Singletons ──────────────────────────────────────────────────────────

const PACKAGE_ID = process.env.OPENX_BRAIN_PACKAGE_ID ?? '';
const USDC_COIN_TYPE = process.env.OPENX_USDC_COIN_TYPE ?? '';
const SPONSOR_KEY =
  process.env.OPENX_LOOP_SPONSOR_PRIVATE_KEY ?? process.env.OPENX_OPERATOR_SUI_PRIVATE_KEY ?? '';
const RPC_URL = process.env.SUI_RPC_URL ?? getFullnodeUrl('testnet');

let _client: SuiClient | null = null;
let _sponsor: Ed25519Keypair | null = null;
const suiClient = () => (_client ??= new SuiClient({ url: RPC_URL }));
const sponsor = (): Ed25519Keypair => {
  if (_sponsor) return _sponsor;
  if (!SPONSOR_KEY) throw new Error('v3-loop: OPENX_LOOP_SPONSOR_PRIVATE_KEY missing');
  const { schema, secretKey } = decodeSuiPrivateKey(SPONSOR_KEY);
  if (schema !== 'ED25519') throw new Error(`v3-loop: sponsor key must be ED25519, got ${schema}`);
  _sponsor = Ed25519Keypair.fromSecretKey(secretKey);
  return _sponsor;
};

let _invoker: LoopAgentInvoker | null = null;
const invoker = () => (_invoker ??= LoopAgentInvoker.loadDefaults(logger));

// ─── Helpers — read on-chain shared objects ─────────────────────────────

async function readAgent(agentObjectId: string) {
  const r = await suiClient().getObject({ id: agentObjectId, options: { showContent: true } });
  const c = r.data?.content;
  if (!c || c.dataType !== 'moveObject') return null;
  return c.fields as Record<string, unknown>;
}

async function readJob(jobObjectId: string) {
  const r = await suiClient().getObject({ id: jobObjectId, options: { showContent: true } });
  const c = r.data?.content;
  if (!c || c.dataType !== 'moveObject') return null;
  return c.fields as Record<string, unknown>;
}

// ─── Public diagnostic ───────────────────────────────────────────────────

router.get('/version', (_req: Request, res: Response) => {
  res.json({
    service: 'openx-loop',
    package_id: PACKAGE_ID,
    network: process.env.SUI_NETWORK ?? 'sui-testnet',
    flags: {
      LOOP: process.env.FEATURE_LOOP !== 'false',
      LOOP_X402: process.env.FEATURE_LOOP_X402 !== 'false',
      LOOP_HIRE: process.env.FEATURE_LOOP_HIRE !== 'false',
      LOOP_GASLESS_PUBLISH: process.env.FEATURE_LOOP_GASLESS_PUBLISH !== 'false',
      LOOP_SEAL_PIPELINE: process.env.FEATURE_LOOP_SEAL_PIPELINE !== 'false',
      LOOP_CHAT_EXECUTION: process.env.FEATURE_LOOP_CHAT_EXECUTION !== 'false',
    },
  });
});

// ─── Agent reads (public) ────────────────────────────────────────────────

router.get('/agents/:id', async (req: Request, res: Response) => {
  const fields = await readAgent(req.params.id);
  if (!fields) return res.status(404).json({ error: 'agent_not_found' });
  res.json({ agent_object_id: req.params.id, ...fields });
});

router.get('/jobs/:objectId', async (req: Request, res: Response) => {
  const fields = await readJob(req.params.objectId);
  if (!fields) return res.status(404).json({ error: 'job_not_found' });
  res.json({ job_object_id: req.params.objectId, ...fields });
});

// ─── Mode A: x402 invoke (auth-gated through paymentGate-like flow) ──────

router.post('/agents/:id/invoke', loopX402Middleware(), async (req: Request, res: Response) => {
  const settle = req.loopX402Settlement;
  if (!settle) return res.status(500).json({ error: 'settlement_missing' });

  const fields = await readAgent(settle.agentObjectId);
  if (!fields) return res.status(404).json({ error: 'agent_disappeared' });

  const manifest = {
    title: String(fields.manifest_walrus_blob_id ?? 'agent'),
    persona_system_prompt: String(req.body?.persona_system_prompt ?? 'You are a helpful AI agent.'),
    default_model_id: String(fields.default_model_id ?? 'claude-opus-4.6'),
    word_limit: typeof req.body?.word_limit === 'number' ? req.body.word_limit : 4000,
  };

  try {
    const result = await invoker().invoke({
      agentObjectId: settle.agentObjectId,
      buyerAddress: settle.payer as `0x${string}`,
      jobNonce: settle.txDigest,
      manifest,
      inputs: {
        text: typeof req.body?.text === 'string' ? req.body.text : undefined,
        walrus_blob_id: typeof req.body?.walrus_blob_id === 'string' ? req.body.walrus_blob_id : undefined,
        sealed_aes_key: req.body?.sealed_aes_key
          ? Buffer.from(String(req.body.sealed_aes_key), 'base64')
          : undefined,
        iv: req.body?.iv ? Buffer.from(String(req.body.iv), 'base64') : undefined,
      },
      correlationId: (req.headers['x-correlation-id'] as string) ?? settle.txDigest,
    });
    res.json({
      tx_digest: settle.txDigest,
      response_walrus_blob_id: result.responseWalrusBlobId,
      sealed_response_key_b64: Buffer.from(result.sealedResponseKey).toString('base64'),
      response_iv_b64: Buffer.from(result.responseIv).toString('base64'),
      response_digest_sha256: result.responseDigestSha256,
      attestation: result.attestation,
      runner_memory_ms: result.runnerMemoryMs,
    });
  } catch (e) {
    logger.error({ err: (e as Error).message }, 'loop:invoke:failed');
    res.status(502).json({ error: 'invoke_failed', detail: (e as Error).message });
  }
});

// ─── Sponsored seller publish ────────────────────────────────────────────

router.post('/seller/publish', async (req: AuthRequest, res: Response) => {
  if (process.env.FEATURE_LOOP_GASLESS_PUBLISH === 'false') {
    return res.status(404).json({ error: 'loop_gasless_publish_disabled' });
  }
  const wallet = req.user?.address;
  if (!wallet) return res.status(401).json({ error: 'wallet_required' });

  const body = req.body as {
    manifest_walrus_blob_id: string;
    persona_system_prompt: string;
    short_description?: string;
    title?: string;
    tags?: string[];
    default_inference_backend?: string;
    default_model_id?: string;
    per_iter_min_micro_usdc?: number;
    per_iter_default_micro_usdc?: number;
    max_iter_per_job?: number;
    seller_bps?: number;
    compute_bps?: number;
    platform_bps?: number;
    /** Optional pre-signed PTB bytes from the wallet — when present, server
     *  co-signs and submits as sponsor (true gasless flow). */
    signed_ptb_bytes_b64?: string;
    buyer_signature?: string;
  };

  if (!body.manifest_walrus_blob_id || !body.persona_system_prompt) {
    return res.status(400).json({ error: 'manifest_walrus_blob_id and persona_system_prompt required' });
  }

  if (body.signed_ptb_bytes_b64 && body.buyer_signature) {
    // Sponsored-tx submit path — exact bytes the wallet signed.
    try {
      const ptbBytes = Buffer.from(body.signed_ptb_bytes_b64, 'base64');
      const sponsorSig = (await sponsor().signTransaction(ptbBytes)).signature;
      const r = await suiClient().executeTransactionBlock({
        transactionBlock: ptbBytes,
        signature: [body.buyer_signature, sponsorSig],
        options: { showEvents: true, showEffects: true, showObjectChanges: true },
      });
      const created = r.objectChanges?.find(
        (c) => c.type === 'created' && (c as { objectType: string }).objectType?.includes('::Agent'),
      ) as { objectId?: string } | undefined;
      const agentObjectId = created?.objectId ?? '';
      if (agentObjectId) {
        await indexLoopAgent(toIndexRecord(agentObjectId, wallet, body));
      }
      return res.json({ ok: true, tx_digest: r.digest, agent_object_id: agentObjectId });
    } catch (e) {
      return res.status(502).json({ error: 'submit_failed', detail: (e as Error).message });
    }
  }

  // Build-only path — caller signs in browser, posts back with signed bytes.
  const tx = buildPublishAgentPtb({
    packageId: PACKAGE_ID,
    manifestWalrusBlobId: body.manifest_walrus_blob_id,
    defaultInferenceBackend: body.default_inference_backend,
    defaultModelId: body.default_model_id,
    perIterMinMicroUsdc: BigInt(body.per_iter_min_micro_usdc ?? 10_000),
    perIterDefaultMicroUsdc: BigInt(body.per_iter_default_micro_usdc ?? 50_000),
    maxIterPerJob: body.max_iter_per_job ?? 10,
    sellerBps: body.seller_bps,
    computeBps: body.compute_bps,
    platformBps: body.platform_bps,
  });
  tx.setSender(wallet);
  tx.setGasOwner(sponsor().toSuiAddress());
  const coins = await suiClient().getCoins({ owner: sponsor().toSuiAddress(), coinType: '0x2::sui::SUI', limit: 1 });
  const gas = coins.data[0];
  if (!gas) return res.status(503).json({ error: 'sponsor_gas_empty' });
  tx.setGasPayment([{ objectId: gas.coinObjectId, version: gas.version, digest: gas.digest }]);
  const ptbBytes = await tx.build({ client: suiClient() });
  res.json({ ptb_bytes_b64: Buffer.from(ptbBytes).toString('base64') });
});

function toIndexRecord(
  agentObjectId: string,
  seller: string,
  body: {
    title?: string;
    short_description?: string;
    persona_system_prompt: string;
    tags?: string[];
    per_iter_default_micro_usdc?: number;
    max_iter_per_job?: number;
    manifest_walrus_blob_id: string;
  },
): LoopAgentIndexRecord {
  return {
    agent_object_id: agentObjectId,
    seller,
    title: body.title ?? 'Loop Agent',
    short_description: body.short_description ?? '',
    persona_summary: body.persona_system_prompt.slice(0, 500),
    tags: body.tags ?? [],
    per_iter_default_micro_usdc: String(body.per_iter_default_micro_usdc ?? 50_000),
    max_iter_per_job: body.max_iter_per_job ?? 10,
    manifest_walrus_blob_id: body.manifest_walrus_blob_id,
  };
}

// ─── Mode B: sponsored hire ──────────────────────────────────────────────

router.post('/jobs/create', async (req: AuthRequest, res: Response) => {
  if (process.env.FEATURE_LOOP_HIRE === 'false') {
    return res.status(404).json({ error: 'loop_hire_disabled' });
  }
  const wallet = req.user?.address;
  if (!wallet) return res.status(401).json({ error: 'wallet_required' });

  const body = req.body as {
    agent_object_id: string;
    max_iterations: number;
    budget_coin_object_id: string;
    signed_ptb_bytes_b64?: string;
    buyer_signature?: string;
  };
  if (!body.agent_object_id || !body.budget_coin_object_id) {
    return res.status(400).json({ error: 'agent_object_id and budget_coin_object_id required' });
  }

  if (body.signed_ptb_bytes_b64 && body.buyer_signature) {
    try {
      const ptbBytes = Buffer.from(body.signed_ptb_bytes_b64, 'base64');
      const sponsorSig = (await sponsor().signTransaction(ptbBytes)).signature;
      const r = await suiClient().executeTransactionBlock({
        transactionBlock: ptbBytes,
        signature: [body.buyer_signature, sponsorSig],
        options: { showEvents: true, showEffects: true, showObjectChanges: true },
      });
      const created = r.objectChanges?.find(
        (c) => c.type === 'created' && (c as { objectType: string }).objectType?.includes('::LoopJob'),
      ) as { objectId?: string } | undefined;
      return res.json({ ok: true, tx_digest: r.digest, job_object_id: created?.objectId ?? '' });
    } catch (e) {
      return res.status(502).json({ error: 'submit_failed', detail: (e as Error).message });
    }
  }

  const tx = buildCreateJobPtb({
    packageId: PACKAGE_ID,
    agentObjectId: body.agent_object_id,
    maxIterations: body.max_iterations,
    budgetCoinObjectId: body.budget_coin_object_id,
    usdcCoinType: USDC_COIN_TYPE,
  });
  tx.setSender(wallet);
  tx.setGasOwner(sponsor().toSuiAddress());
  const coins = await suiClient().getCoins({ owner: sponsor().toSuiAddress(), coinType: '0x2::sui::SUI', limit: 1 });
  const gas = coins.data[0];
  if (!gas) return res.status(503).json({ error: 'sponsor_gas_empty' });
  tx.setGasPayment([{ objectId: gas.coinObjectId, version: gas.version, digest: gas.digest }]);
  const ptbBytes = await tx.build({ client: suiClient() });
  res.json({ ptb_bytes_b64: Buffer.from(ptbBytes).toString('base64') });
});

// ─── Concierge ───────────────────────────────────────────────────────────

router.post('/concierge/search', async (req: Request, res: Response) => {
  if (process.env.FEATURE_LOOP_CHAT_EXECUTION === 'false') {
    return res.status(404).json({ error: 'loop_chat_execution_disabled' });
  }
  const message = String(req.body?.message ?? '');
  const buyerAddress = typeof req.body?.buyer_address === 'string' ? req.body.buyer_address : undefined;
  const r = await conciergeSearch({ message, buyerAddress, limit: 5 });
  res.json(r);
});

export default router;
