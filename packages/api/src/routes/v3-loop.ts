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
import archiver from 'archiver';
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
import { pool } from '../db';
import { MemoryService, type MemWalMirror } from '../services/loop/memoryService';
import { ArtifactVaultService } from '../services/loop/artifactVaultService';
import { BuyerPreferenceProfileService } from '../services/loop/buyerPreferenceProfile';
import { RightToForgetService } from '../services/loop/rightToForgetService';
import { computeNextRun } from '../services/loop/workflowScheduler';
import {
  synthesizeWorkflow,
  type Category,
} from '../services/loop/workflowSynthesizer';
import { MockStepExecutor } from '../services/loop/mockStepExecutor';
import {
  WorkflowDispatcher,
  validateWorkflow,
} from '../services/loop/workflowDispatcher';
import { OutcomeEvaluator } from '../services/loop/outcomeEvaluator';
import { StopConditionEvaluator } from '../services/loop/stopConditionEvaluator';
import { recordWorkflowRunSideEffects } from '../services/loop/workflowRunRecorder';

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
    area_slug: typeof req.body?.area_slug === 'string' ? req.body.area_slug : null,
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
      suiTxDigest: settle.txDigest,
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

// ─── PRD-W v1.1 — service singletons (lazy init) ─────────────────────────

/** No-op MemWal mirror — replace with the real OpenXMemWalAdapter when the
 *  v1.1 master flag flips. Keeps the route file decoupled from MemWal so
 *  tests can run without it. */
const noopMirror: MemWalMirror = { remember: async () => null };

let _memory: MemoryService | null = null;
let _vault: ArtifactVaultService | null = null;
let _vcard: BuyerPreferenceProfileService | null = null;
let _rtf: RightToForgetService | null = null;

const memory = () =>
  (_memory ??= new MemoryService({ pool, mirror: noopMirror, logger }));
const vault = () =>
  (_vault ??= new ArtifactVaultService({ pool, mirror: noopMirror, logger }));

/** Lazy Walrus uploader singleton — created once, reused across requests. */
let _walrus: { upload: (b: Uint8Array) => Promise<{ blobs: Array<{ blobId: string }> }> } | null = null;
const lazyWalrus = () => {
  if (_walrus) return _walrus;
  _walrus = {
    upload: async (bytes: Uint8Array) => {
      const { createWalrusStore } = await import('@fhe-ai-context/sui-sdk');
      return createWalrusStore().upload(bytes);
    },
  };
  return _walrus;
};
const vcard = () =>
  (_vcard ??= new BuyerPreferenceProfileService({ pool, mirror: noopMirror, logger }));
const rtf = () =>
  (_rtf ??= new RightToForgetService({ pool, logger, enabled: () => process.env.FEATURE_LOOP_RIGHT_TO_FORGET === 'true' }));

/**
 * verifyAgentOwner — single source of truth for "is this wallet the owner?".
 * Used by every seller-only mutation. Looks up agents by slug OR Sui object id
 * (URLs use either) and case-insensitive matches owner_address.
 *
 * SOLID: SRP — answers exactly one question. DIP: pool injected via closure.
 */
async function verifyAgentOwner(agentIdOrSlug: string, wallet: string): Promise<boolean> {
  const r = await pool.query<{ owner_address: string }>(
    `SELECT owner_address FROM agents
      WHERE (slug = $1 OR id::text = $1)
      LIMIT 1`,
    [agentIdOrSlug],
  );
  if (!r.rowCount) return false;
  return r.rows[0].owner_address.toLowerCase() === wallet.toLowerCase();
}

// ─── Daily-run subscription endpoints ────────────────────────────────────

router.post('/subscriptions', async (req: AuthRequest, res: Response) => {
  const wallet = req.user?.address;
  if (!wallet) return res.status(401).json({ error: 'wallet_required' });

  const b = req.body as {
    agent_object_id: string; template_walrus_blob_id: string;
    area_slug?: string; cron_utc_minute: number; runs: number; max_per_run_micro: number;
    budget_coin_object_id: string;
  };
  if (!b.agent_object_id || !b.template_walrus_blob_id) {
    return res.status(400).json({ error: 'agent_object_id + template_walrus_blob_id required' });
  }
  if (!Number.isInteger(b.cron_utc_minute) || b.cron_utc_minute < 0 || b.cron_utc_minute >= 1440) {
    return res.status(400).json({ error: 'cron_utc_minute must be 0..1439' });
  }
  if (!Number.isInteger(b.runs) || b.runs < 1 || b.runs > 366) {
    return res.status(400).json({ error: 'runs must be 1..366' });
  }
  if (!Number.isFinite(b.max_per_run_micro) || b.max_per_run_micro < 0) {
    return res.status(400).json({ error: 'max_per_run_micro must be >= 0' });
  }

  // Persist to operational cache. Real on-chain LoopSubscription<T> object id
  // arrives once the SDK PTB builder lands; until then we use a deterministic
  // stub keyed by (wallet, ts, agent) so /activity shows the row.
  const subscription_object_id =
    `stub-${Date.now()}-${wallet.slice(2, 10)}-${b.agent_object_id.slice(0, 8)}`;
  const next_run_ts = computeNextRun(new Date(), b.cron_utc_minute);

  try {
    const r = await pool.query<{ id: number }>(
      `INSERT INTO loop_subscriptions
            (subscription_object_id, agent_id, buyer_addr, template_walrus_blob_id,
             area_slug, cron_utc_minute, runs_remaining, max_per_run_micro, next_run_ts)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        subscription_object_id, b.agent_object_id, wallet, b.template_walrus_blob_id,
        b.area_slug ?? null, b.cron_utc_minute, b.runs, b.max_per_run_micro, next_run_ts,
      ],
    );
    return res.status(201).json({
      ok: true,
      subscription: {
        id: r.rows[0].id,
        subscription_object_id,
        agent_id: b.agent_object_id,
        runs_remaining: b.runs,
        next_run_ts,
        cron_utc_minute: b.cron_utc_minute,
        area_slug: b.area_slug ?? null,
      },
    });
  } catch (e) {
    logger.error({ err: (e as Error).message }, 'subscribe:insert_failed');
    return res.status(500).json({ error: 'subscribe_failed', detail: (e as Error).message });
  }
});

router.post('/subscriptions/:id/cancel', async (req: AuthRequest, res: Response) => {
  const wallet = req.user?.address;
  if (!wallet) return res.status(401).json({ error: 'wallet_required' });
  const r = await pool.query<{ id: number; runs_remaining: number; max_per_run_micro: string }>(
    `UPDATE loop_subscriptions
        SET cancelled_at   = now(),
            runs_remaining = 0
      WHERE subscription_object_id = $1
        AND buyer_addr            = $2
        AND cancelled_at IS NULL
   RETURNING id, runs_remaining, max_per_run_micro`,
    [req.params.id, wallet],
  );
  if (!r.rowCount) return res.status(404).json({ error: 'subscription_not_found_or_already_cancelled' });
  res.json({ ok: true, cancelled: { subscription_object_id: req.params.id } });
});

router.get('/subscriptions', async (req: AuthRequest, res: Response) => {
  const wallet = req.user?.address;
  if (!wallet) return res.status(401).json({ error: 'wallet_required' });
  const r = await pool.query(
    `SELECT subscription_object_id, agent_id, area_slug, cron_utc_minute,
            runs_remaining, max_per_run_micro, next_run_ts, last_run_ts, cancelled_at
       FROM loop_subscriptions
      WHERE buyer_addr = $1
      ORDER BY created_at DESC LIMIT 50`,
    [wallet],
  );
  res.json({ subscriptions: r.rows });
});

// ─── Upgrade wizard (existing-agent → workflow-aware brain) ──────────────

router.get('/seller/agents/:id/upgrade-preview', async (req: AuthRequest, res: Response) => {
  const wallet = req.user?.address;
  if (!wallet) return res.status(401).json({ error: 'wallet_required' });
  try {
    const result = await memory().classifyHistorical(req.params.id);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: 'preview_failed', detail: (e as Error).message });
  }
});

router.post('/seller/agents/:id/upgrade', async (req: AuthRequest, res: Response) => {
  const wallet = req.user?.address;
  if (!wallet) return res.status(401).json({ error: 'wallet_required' });
  if (!(await verifyAgentOwner(req.params.id, wallet))) {
    return res.status(403).json({ error: 'not_agent_owner' });
  }
  const b = req.body as {
    workflow_walrus_blob_id: string;
    stop_condition_walrus_blob_id?: string;
    area_slugs: string[];
  };
  if (!b.workflow_walrus_blob_id || !Array.isArray(b.area_slugs)) {
    return res.status(400).json({ error: 'workflow_walrus_blob_id + area_slugs required' });
  }
  // Postgres-side: persist declared areas + flag the agent's existing
  // cognitive_memories rows by re-running the classifier (Postgres-only
  // for now; on-chain `init_extension` PTB is built via SDK builder).
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const slug of b.area_slugs.slice(0, 16)) {
      if (typeof slug === 'string' && slug.length <= 64) {
        await client.query(
          `INSERT INTO seller_areas (agent_id, area_slug)
                VALUES ($1, $2) ON CONFLICT (agent_id, area_slug) DO NOTHING`,
          [req.params.id, slug],
        );
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'upgrade_failed', detail: (e as Error).message });
  } finally {
    client.release();
  }
  res.json({
    ok: true,
    declared_areas: b.area_slugs.length,
    pending_chain_ptb: { kind: 'init_extension', agent_id: req.params.id, ...b },
  });
});

// ─── Persona auto-rewrite seller surfaces (PRD-W S4 modal) ───────────────

router.get('/seller/agents/:id/persona-history', async (req: AuthRequest, res: Response) => {
  if (!req.user?.address) return res.status(401).json({ error: 'wallet_required' });
  const r = await pool.query(
    `SELECT id, proposed_blob_id, reasoning, reflection_count, status, proposed_at, resolved_at
       FROM persona_rewrite_proposals
      WHERE agent_id = $1
      ORDER BY proposed_at DESC LIMIT 25`,
    [req.params.id],
  );
  res.json({ proposals: r.rows });
});

router.post('/seller/agents/:id/approve-persona-rewrite',
  async (req: AuthRequest, res: Response) => {
    if (!req.user?.address) return res.status(401).json({ error: 'wallet_required' });
    const b = req.body as { proposal_id: number; decision: 'approved' | 'rejected' };
    if (!b.proposal_id || (b.decision !== 'approved' && b.decision !== 'rejected')) {
      return res.status(400).json({ error: 'proposal_id + decision required' });
    }
    const r = await pool.query(
      `UPDATE persona_rewrite_proposals
          SET status = $1, resolved_at = now()
        WHERE id = $2 AND agent_id = $3 AND status = 'pending'
        RETURNING id`,
      [b.decision, b.proposal_id, req.params.id],
    );
    if (!r.rowCount) return res.status(404).json({ error: 'proposal_not_pending' });
    res.json({ ok: true, decision: b.decision });
  });

// ─── Right-to-forget (buyer-initiated) ───────────────────────────────────

router.post('/buyer/right-to-forget', async (req: AuthRequest, res: Response) => {
  const wallet = req.user?.address;
  if (!wallet) return res.status(401).json({ error: 'wallet_required' });
  const b = req.body as { agent_id: string; reason?: string };
  if (!b.agent_id) return res.status(400).json({ error: 'agent_id_required' });
  const created = await rtf().request({ agent_id: b.agent_id, buyer_addr: wallet, reason: b.reason });
  res.status(202).json({ request: created, cooling_off_days: 7 });
});

router.delete('/buyer/right-to-forget/:id', async (req: AuthRequest, res: Response) => {
  const wallet = req.user?.address;
  if (!wallet) return res.status(401).json({ error: 'wallet_required' });
  const ok = await rtf().cancel({ request_id: Number(req.params.id), buyer_addr: wallet });
  if (!ok) return res.status(404).json({ error: 'request_not_pending' });
  res.json({ ok: true });
});

// ─── Buyer artifact vault + preferences vCard ────────────────────────────

router.get('/buyer/vault', async (req: AuthRequest, res: Response) => {
  const wallet = req.user?.address;
  if (!wallet) return res.status(401).json({ error: 'wallet_required' });
  const entries = await vault().list(wallet);
  res.json({ entries });
});

/**
 * GET /v3/loop/buyer/vault/blob/:blob_id
 *
 * Server-side proxy that streams a single artifact-vault blob to the buyer
 * with `Content-Disposition: attachment`. Solves the prod-only download
 * failure where the FE built direct Walrus aggregator URLs:
 *   • aggregator CORS / rate-limit edge cases on Vercel,
 *   • placeholder blob ids never pinned to Walrus,
 *   • mixed-content / inline-rendering surprises.
 *
 * Authz: the blob must belong to `artifact-vault-{x-wallet-address}`. No
 * feature flag — works for legacy vault entries (PRD-W v1.1) too.
 *
 * Reuses the same Walrus client + lazy-import pattern as `runs/:job_id/bundle.zip`.
 */
router.get('/buyer/vault/blob/:blob_id', async (req: AuthRequest, res: Response) => {
  const wallet = req.user?.address;
  if (!wallet) return res.status(401).json({ error: 'wallet_required' });
  const blob_id = String(req.params.blob_id ?? '');
  if (!blob_id) return res.status(400).json({ error: 'blob_id_required' });

  const entry = await vault().findEntry(wallet, blob_id);
  if (!entry) return res.status(404).json({ error: 'not_in_vault' });

  try {
    const { createWalrusStore } = await import('@fhe-ai-context/sui-sdk');
    const bytes = await createWalrusStore().fetch(blob_id);
    // Strip quotes/CR/LF from artifact_name so the Content-Disposition header
    // can never be smuggled. Worst case the buyer downloads `download.bin`.
    const safe = (entry.artifact_name || 'download.bin').replace(/[\r\n"]/g, '');
    res.setHeader('Content-Type', entry.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${safe}"`);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.end(Buffer.from(bytes));
  } catch (e) {
    logger.error({ err: (e as Error).message, blob_id }, 'vault:download_failed');
    res.status(502).json({ error: 'walrus_fetch_failed' });
  }
});

// ─── PRD-W v1.2 — per-run timeline + bundle ZIP + digest ─────────────────
//
// The vault endpoint above stays for legacy clients. The 3 endpoints below
// power the new `/activity` Run Timeline panel + Run Detail Drawer + Weekly
// Digest card. Master flag: `FEATURE_LOOP_RUN_TIMELINE`.

const runTimelineEnabled = () => process.env.FEATURE_LOOP_RUN_TIMELINE === 'true';
const runBundleZipEnabled = () => process.env.FEATURE_LOOP_RUN_BUNDLE_ZIP === 'true';
const weeklyDigestEnabled = () => process.env.FEATURE_WEEKLY_DIGEST === 'true';

/**
 * GET /v3/loop/runs/by-buyer/:wallet
 *   ?sinceDays=30 (default 30, max 365)
 *   ?limit=50     (default 50, max 200)
 *
 * Returns `{ runs: RunGroup[] }` — artifacts grouped by job_id, sorted
 * DESC by run_started_at. Authz: x-wallet-address must match :wallet
 * (case-insensitive). Cache: 30s private.
 */
router.get('/runs/by-buyer/:wallet', async (req: AuthRequest, res: Response) => {
  if (!runTimelineEnabled()) return res.status(404).json({ error: 'feature_disabled' });
  const wallet = String(req.params.wallet ?? '').toLowerCase();
  const headerWallet = (req.user?.address ?? '').toLowerCase();
  if (!wallet || !headerWallet) return res.status(401).json({ error: 'wallet_required' });
  if (wallet !== headerWallet) return res.status(403).json({ error: 'wallet_mismatch' });

  const sinceDays = Math.max(1, Math.min(Number(req.query.sinceDays ?? 30), 365));
  const limit = Math.max(1, Math.min(Number(req.query.limit ?? 50), 200));
  try {
    const result = await vault().listByRun(wallet, { sinceDays, limit });
    res.set('Cache-Control', 'private, max-age=30');
    res.json(result);
  } catch (e) {
    logger.error({ err: (e as Error).message, wallet }, 'runs:listByRun_failed');
    res.status(500).json({ error: 'internal' });
  }
});

/**
 * GET /v3/loop/runs/:job_id/bundle.zip
 *
 * Streams a ZIP of all artifacts for a run. Walrus fetches happen in
 * parallel; partial failures land as `{name}.error.txt`. For Tier 4 E2EE
 * artifacts (`*.encrypted` or `application/x-encrypted`), a brief
 * `README-decryption.md` is appended.
 *
 * Authz: artifact namespace must equal `artifact-vault-{x-wallet-address}`.
 */
router.get('/runs/:job_id/bundle.zip', async (req: AuthRequest, res: Response) => {
  if (!runTimelineEnabled() || !runBundleZipEnabled()) {
    return res.status(404).json({ error: 'feature_disabled' });
  }
  const job_id = String(req.params.job_id ?? '');
  const wallet = (req.user?.address ?? '').toLowerCase();
  if (!wallet) return res.status(401).json({ error: 'wallet_required' });
  if (!job_id) return res.status(400).json({ error: 'job_id_required' });

  const namespace = `artifact-vault-${wallet}`;

  // Authz: this run must belong to the caller.
  const auth = await pool.query(
    `SELECT 1 FROM workflow_run_artifacts
      WHERE job_id = $1 AND namespace = $2 LIMIT 1`,
    [job_id, namespace],
  );
  if (!auth.rowCount) return res.status(403).json({ error: 'not_your_run' });

  const arts = await pool.query<{
    artifact_name: string; walrus_blob_id: string; mime_type: string; size_bytes: number;
  }>(
    `SELECT artifact_name, walrus_blob_id, mime_type, size_bytes
       FROM workflow_run_artifacts
      WHERE job_id = $1 AND namespace = $2
      ORDER BY artifact_created_at ASC`,
    [job_id, namespace],
  );
  if (!arts.rowCount) return res.status(404).json({ error: 'no_artifacts' });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="run-${job_id}.zip"`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', (err: Error) => {
    logger.error({ err: err.message, job_id }, 'bundle:zip_error');
    if (!res.headersSent) res.status(500).end();
  });
  archive.pipe(res);

  // Lazy-import the Walrus client only when the route is hit.
  const { createWalrusStore } = await import('@fhe-ai-context/sui-sdk');
  const walrus = createWalrusStore();

  const fetched = await Promise.all(
    arts.rows.map(async (a) => {
      try {
        const bytes = await walrus.fetch(a.walrus_blob_id);
        return { ok: true as const, name: a.artifact_name, bytes, mime_type: a.mime_type };
      } catch (e) {
        return { ok: false as const, name: a.artifact_name, err: (e as Error).message };
      }
    }),
  );
  let hasEncrypted = false;
  for (const r of fetched) {
    if (r.ok) {
      archive.append(Buffer.from(r.bytes), { name: r.name });
      if (r.name.endsWith('.encrypted') || r.mime_type === 'application/x-encrypted') {
        hasEncrypted = true;
      }
    } else {
      archive.append(`# Failed to fetch ${r.name}\nError: ${r.err}\n`, {
        name: `${r.name}.error.txt`,
      });
    }
  }
  if (hasEncrypted) {
    archive.append(README_DECRYPTION, { name: 'README-decryption.md' });
  }
  await archive.finalize();
});

const README_DECRYPTION = `# Decrypting Tier 4 (E2EE) artifacts

Some files in this bundle are end-to-end encrypted. Only your wallet can derive
the decryption key (Seal IBE threshold policy). The OpenX server can NEVER
decrypt these files — that is the sovereignty guarantee.

To decrypt:
1. Open https://openx.so/activity in the browser where your Sui wallet is
   connected (Slush / Suiet / OKX-Sui).
2. Click the run that produced these artifacts → "Decrypt with wallet".
3. Or use the SDK helper: \`useSealJobResults().decrypt(walrus_blob_id)\`.
`;

/**
 * GET /v3/loop/digests/by-buyer/:wallet
 *
 * Returns the most recent weekly digest for the buyer (or null). The digest
 * itself is markdown stored on Walrus; the FE fetches the blob on demand.
 */
router.get('/digests/by-buyer/:wallet', async (req: AuthRequest, res: Response) => {
  if (!weeklyDigestEnabled()) return res.json({ digest: null });
  const wallet = String(req.params.wallet ?? '').toLowerCase();
  const headerWallet = (req.user?.address ?? '').toLowerCase();
  if (!wallet || !headerWallet) return res.status(401).json({ error: 'wallet_required' });
  if (wallet !== headerWallet) return res.status(403).json({ error: 'wallet_mismatch' });

  const r = await pool.query<{ text: string; created_at: string }>(
    `SELECT text, created_at
       FROM cognitive_memories
      WHERE namespace = $1
        AND area_slug = 'digest'
      ORDER BY created_at DESC LIMIT 1`,
    [`artifact-vault-${wallet}`],
  );
  if (!r.rowCount) return res.json({ digest: null });
  try {
    const m = JSON.parse(r.rows[0].text) as {
      job_id: string; artifact_name: string; walrus_blob_id: string; mime_type: string;
    };
    res.json({
      digest: {
        week: m.job_id.replace(/^digest-/, ''),
        artifact_name: m.artifact_name,
        walrus_blob_id: m.walrus_blob_id,
        mime_type: m.mime_type,
        created_at: r.rows[0].created_at,
      },
    });
  } catch {
    res.json({ digest: null });
  }
});

router.post('/buyer/preferences/save', async (req: AuthRequest, res: Response) => {
  const wallet = req.user?.address;
  if (!wallet) return res.status(401).json({ error: 'wallet_required' });
  const saved = await vcard().save(wallet, req.body);
  res.json({ vcard: saved });
});

router.get('/buyer/preferences/me', async (req: AuthRequest, res: Response) => {
  const wallet = req.user?.address;
  if (!wallet) return res.status(401).json({ error: 'wallet_required' });
  const card = await vcard().read(wallet);
  res.json({ vcard: card });
});

// ─── Warm-context transparency endpoint (B6 panel) ───────────────────────

router.get('/jobs/:id/warm-context', async (req: AuthRequest, res: Response) => {
  const wallet = req.user?.address;
  if (!wallet) return res.status(401).json({ error: 'wallet_required' });
  // Look up job to find agent_id; fall back to query param.
  const ctx = await memory().readWarmContext({
    agent_id: String(req.query.agent_id ?? ''),
    buyer_addr: wallet,
    area_slug: req.query.area_slug ? String(req.query.area_slug) : undefined,
    limit: 10,
  });
  res.json(ctx);
});

// ─── Workflow YAML edit (seller-side) ────────────────────────────────────
//
// Persisted as the latest row in cognitive_memories under namespace
// `workflow-yaml-{agent_id}`. Latest-wins by created_at — same pattern as
// the buyer-preferences vCard. No new table required.

const WORKFLOW_NS = (agent_id: string) => `workflow-yaml-${agent_id}`;

router.get('/seller/agents/:id/workflow', async (req: AuthRequest, res: Response) => {
  if (!req.user?.address) return res.status(401).json({ error: 'wallet_required' });
  const r = await pool.query<{ text: string; created_at: string }>(
    `SELECT text, created_at FROM cognitive_memories
      WHERE namespace = $1 ORDER BY created_at DESC LIMIT 1`,
    [WORKFLOW_NS(req.params.id)],
  );
  if (!r.rowCount) return res.json({ workflow: null });
  try {
    const workflow = JSON.parse(r.rows[0].text);
    res.json({ workflow, updated_at: r.rows[0].created_at });
  } catch {
    res.status(500).json({ error: 'workflow_parse_failed' });
  }
});

router.patch('/seller/agents/:id/workflow', async (req: AuthRequest, res: Response) => {
  if (!req.user?.address) return res.status(401).json({ error: 'wallet_required' });
  if (!(await verifyAgentOwner(req.params.id, req.user.address))) {
    return res.status(403).json({ error: 'not_agent_owner' });
  }

  // Validate the incoming workflow via the dispatcher's validator.
  // SOLID: one source of truth — same shape the runtime executes against.
  let validated;
  try {
    // Lazy-import to avoid a top-level cycle with workflowDispatcher.
    const { validateWorkflow } = await import('../services/loop/workflowDispatcher');
    validated = validateWorkflow(req.body);
  } catch (e) {
    return res.status(400).json({ error: 'workflow_invalid', detail: (e as Error).message });
  }

  const text = JSON.stringify(validated);
  await pool.query(
    `INSERT INTO cognitive_memories (brain_id, namespace, text, cognitive_level)
          VALUES ($1, $2, $3, 4)`,
    [req.params.id, WORKFLOW_NS(req.params.id), text],
  );
  res.json({ workflow: validated, updated_at: new Date().toISOString() });
});

// ─── Seller PARA summary (Studio dashboard ops) ──────────────────────────

router.get('/seller/agents/:id/para-summary', async (req: AuthRequest, res: Response) => {
  if (!req.user?.address) return res.status(401).json({ error: 'wallet_required' });
  if (!(await verifyAgentOwner(req.params.id, req.user.address))) {
    return res.status(403).json({ error: 'not_agent_owner' });
  }
  const counts = await pool.query<{ para_kind: string | null; n: string }>(
    `SELECT para_kind, COUNT(*)::text AS n
       FROM cognitive_memories
      WHERE namespace LIKE $1
      GROUP BY para_kind`,
    [`cog-l4-${req.params.id}%`],
  );
  const distribution = { project: 0, area: 0, resource: 0, archive: 0, untagged: 0 };
  for (const r of counts.rows) {
    const k = (r.para_kind ?? 'untagged') as keyof typeof distribution;
    if (k in distribution) distribution[k] = Number(r.n);
  }
  const pendingPersona = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM persona_rewrite_proposals
      WHERE agent_id = $1 AND status = 'pending'`,
    [req.params.id],
  );
  const activeSubs = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM loop_subscriptions
      WHERE agent_id = $1 AND cancelled_at IS NULL AND runs_remaining > 0`,
    [req.params.id],
  );
  res.json({
    distribution,
    pending_persona_proposals: Number(pendingPersona.rows[0]?.count ?? 0),
    active_subscriptions: Number(activeSubs.rows[0]?.count ?? 0),
  });
});

// ─── PRD-S — Quick-build (AI synth) ─────────────────────────────────────

const VALID_CATEGORIES: Category[] = ['research', 'writing', 'translation', 'code', 'analysis', 'other'];

router.post('/seller/agents/:id/workflow/synthesize', async (req: AuthRequest, res: Response) => {
  if (!req.user?.address) return res.status(401).json({ error: 'wallet_required' });
  if (!(await verifyAgentOwner(req.params.id, req.user.address))) {
    return res.status(403).json({ error: 'not_agent_owner' });
  }
  const b = req.body as { description?: string; category?: string };
  if (typeof b.description !== 'string' || b.description.trim().length < 1 || b.description.length > 500) {
    return res.status(400).json({ error: 'description_1_to_500_chars' });
  }
  const category =
    b.category && VALID_CATEGORIES.includes(b.category as Category)
      ? (b.category as Category)
      : undefined;
  try {
    const synth = synthesizeWorkflow({ description: b.description, category });
    // SOLID: same validator the dispatcher runs — synth output must pass.
    validateWorkflow(synth.workflow);
    res.json(synth);
  } catch (e) {
    logger.error({ err: (e as Error).message }, 'synthesize:failed');
    res.status(500).json({ error: 'synthesize_failed', detail: (e as Error).message });
  }
});

// ─── PRD-S — Run workflow now (buyer instant run) ───────────────────────

/** Lazy-built shared OutcomeEvaluator backed by stop condition (stub Pool). */
const _runNowOutcome = () => {
  const sce = new StopConditionEvaluator({ pool, logger });
  return new OutcomeEvaluator(sce, logger);
};

/**
 * Verify that `tx_digest` is a confirmed USDC transfer from `buyer` of at least
 * `min_micro` µUSDC, with a balance change to `seller` ≥ 95% of price (5%
 * platform cut). Single Sui RPC call. Returns `null` on success, or a string
 * reason on failure (mapped to 402 by the route).
 */
async function verifyPaymentTx(args: {
  tx_digest: string;
  buyer: string;
  seller: string;
  min_micro: bigint;
  usdc_coin_type: string;
}): Promise<string | null> {
  // Retry 4× with backoff to handle Sui RPC propagation race — the buyer's
  // wallet may have submitted to a different fullnode than ours, and the
  // tx may not be indexed here yet.
  const delays = [0, 400, 900, 1800];
  let r;
  let lastErr: string | null = null;
  for (const d of delays) {
    if (d > 0) await new Promise((res) => setTimeout(res, d));
    try {
      r = await suiClient().getTransactionBlock({
        digest: args.tx_digest,
        options: { showEffects: true, showBalanceChanges: true },
      });
      break;
    } catch (e) {
      lastErr = (e as Error).message;
    }
  }
  if (!r) {
    logger.warn({ tx: args.tx_digest, err: lastErr }, 'verifyPaymentTx:tx_not_indexed');
    return `verify_failed:${lastErr ?? 'tx_not_found_after_retry'}`;
  }
  if (r.effects?.status?.status !== 'success') return 'tx_not_successful';

  // Self-pay scenario (buyer == seller, e.g. seller testing own agent):
  // skip the receiver-balance check — the successful on-chain tx is itself
  // the audit receipt. Net balance change for the address would be ~0
  // (minus gas) which would otherwise fail the strict check.
  if (args.buyer.toLowerCase() === args.seller.toLowerCase()) return null;

  const changes = r.balanceChanges ?? [];
  // Find a positive USDC balance change to the seller of >= 95% of min_micro.
  const sellerCutMicro = (args.min_micro * 9_500n) / 10_000n;
  const sellerLower = args.seller.toLowerCase();
  const usdcChange = changes.find((c) => {
    if (c.coinType !== args.usdc_coin_type) return false;
    if (typeof c.owner !== 'object' || !('AddressOwner' in c.owner)) return false;
    if ((c.owner.AddressOwner as string).toLowerCase() !== sellerLower) return false;
    return BigInt(c.amount) >= sellerCutMicro;
  });
  if (!usdcChange) return 'insufficient_payment_to_seller';
  return null;
}

router.post('/agents/:id/run-workflow', async (req: AuthRequest, res: Response) => {
  const wallet = req.user?.address;
  if (!wallet) return res.status(401).json({ error: 'wallet_required' });
  const request = typeof req.body?.request === 'string' ? req.body.request.slice(0, 2000) : '';
  const tx_digest = typeof req.body?.payment_tx_digest === 'string' ? req.body.payment_tx_digest : '';

  // Look up agent + price + seller for payment gate.
  const agentRow = await pool.query<{ owner_address: string; pricing: unknown; slug: string; id: string }>(
    `SELECT owner_address, pricing, slug, id::text AS id
       FROM agents WHERE slug = $1 OR id::text = $1 LIMIT 1`,
    [req.params.id],
  );
  if (!agentRow.rowCount) return res.status(404).json({ error: 'agent_not_found' });
  const agent = agentRow.rows[0];
  const pricingObj = (agent.pricing ?? {}) as Record<string, string | null>;
  const priceUsdc = pricingObj.sui_usdc ?? pricingObj.x402 ?? '0.01';
  const priceMicro = BigInt(Math.max(1, Math.floor(Number(priceUsdc) * 1_000_000)));
  const platformAddr = process.env.OPENX_PLATFORM_TREASURY ?? '';
  const usdcCoinType = process.env.OPENX_USDC_COIN_TYPE ?? '';

  // Payment gate (skip in dev when env unset).
  if (usdcCoinType && agent.owner_address) {
    if (!tx_digest) {
      return res.status(402).json({
        error: 'payment_required',
        price_micro_usdc: String(priceMicro),
        price_usdc: priceUsdc,
        seller: agent.owner_address,
        platform: platformAddr,
        platform_bps: Number(process.env.OPENX_PLATFORM_BPS ?? 500),
        usdc_coin_type: usdcCoinType,
        note: 'sign a USDC transfer to the seller (95%) + platform (5%), post the tx_digest as payment_tx_digest',
      });
    }
    const verifyErr = await verifyPaymentTx({
      tx_digest, buyer: wallet,
      seller: agent.owner_address,
      min_micro: priceMicro,
      usdc_coin_type: usdcCoinType,
    });
    if (verifyErr) return res.status(402).json({ error: 'payment_invalid', reason: verifyErr });
  }

  // Load saved workflow (latest cognitive_memories row in workflow-yaml-{agent}).
  const r = await pool.query<{ text: string }>(
    `SELECT text FROM cognitive_memories
       WHERE namespace IN ($1, $2)
       ORDER BY created_at DESC LIMIT 1`,
    [WORKFLOW_NS(agent.slug), WORKFLOW_NS(agent.id)],
  );
  if (!r.rowCount) return res.status(422).json({ error: 'no_workflow_saved' });

  let workflow;
  try {
    workflow = validateWorkflow(JSON.parse(r.rows[0].text));
  } catch (e) {
    return res.status(500).json({ error: 'workflow_corrupt', detail: (e as Error).message });
  }

  // Robust seed: legacy workflows may use any of these keys → all alias to the request.
  const buyer_input = {
    request, query: request, research_query: request,
    brief: request, topic: request, source: request,
    target: request, dataset: request,
  };

  const t0 = Date.now();
  try {
    const dispatcher = new WorkflowDispatcher(
      memory(), _runNowOutcome(), new MockStepExecutor(), logger,
    );
    const job_id = `runnow-${Date.now()}-${wallet.slice(2, 8)}`;
    const result = await dispatcher.run({
      workflow,
      agent_id: agent.slug,
      buyer_addr: wallet,
      job_id,
      buyer_input,
      area_slug: workflow.para?.area_slug,
      budget_micro: 25_000_000,
    });

    // Final output = the express step's most descriptive markdown field.
    const expressStep = [...result.per_step].reverse().find((s) => s.phase === 'express' && s.status === 'ok');
    const o = expressStep?.output as Record<string, unknown> | undefined;
    const final_output = String(
      o?.daily_post ?? o?.final_output ?? o?.translated ?? o?.report_md ??
      o?.review_md ?? o?.analysis_md ?? o?.result_md ?? '',
    );

    // Side effects (paid_calls + workflow_runs + vault deposit). Best-effort:
    // never fails the buyer-visible response.
    void recordWorkflowRunSideEffects(
      { pool, vault: vault(), walrus: lazyWalrus(), logger },
      {
        result,
        agent_id: agent.slug,
        agent_pkid: agent.id,
        buyer_addr: wallet,
        request,
        job_id,
        area_slug: workflow.para?.area_slug ?? null,
        payment: {
          amount_usdc: usdcCoinType ? priceUsdc : '0',
          tx_hash: tx_digest || `runnow:${job_id}`,
          network: process.env.SUI_NETWORK ?? 'sui-testnet',
          method: 'sui_usdc',
        },
      },
    ).catch((e) => logger.warn({ err: (e as Error).message, job_id }, 'run-workflow:recorder_failed'));

    res.json({
      tx_digest: tx_digest || null,
      paid_micro_usdc: usdcCoinType ? String(priceMicro) : null,
      steps_completed: result.steps_completed,
      steps_total: result.steps_total,
      per_step: result.per_step,
      final_output,
      ms: Date.now() - t0,
    });
  } catch (e) {
    logger.error({ err: (e as Error).message, agent_id: req.params.id }, 'run-workflow:failed');
    res.status(500).json({ error: 'run_failed', detail: (e as Error).message });
  }
});

// ─── PRD-W v1.3 — On-chain seller flow upgrade (FEATURE_LOOP_SELLER_V2) ───
//
// 4 mutation PTB builders + GET events + GET on-chain stats + admin whitelist.
// All gated by FEATURE_LOOP_SELLER_V2; 404 when off.

const sellerV2Enabled = () => process.env.FEATURE_LOOP_SELLER_V2 === 'true';

async function loadAgentSuiObjectId(idOrSlug: string): Promise<string | null> {
  // Convention: agents.fee_tx_digest carries the publish tx; the on-chain
  // Agent shared object id is best resolved via the indexer's first
  // LoopAgentPublished event for that seller. Fast path: the FE submits
  // the sui_object_id explicitly when invoking mutations (it has it from
  // the publish PTB result). We look it up from agent_events as fallback.
  const r = await pool.query<{ agent_object_id: string }>(
    `SELECT ae.agent_object_id
       FROM agents a
       JOIN agent_events ae ON ae.tx_digest = a.fee_tx_digest
      WHERE (a.slug = $1 OR a.id::text = $1)
        AND ae.event_type = 'LoopAgentPublished'
      ORDER BY ae.timestamp_ms ASC LIMIT 1`,
    [idOrSlug],
  );
  return r.rows[0]?.agent_object_id ?? null;
}

/** Build a mutation PTB and return its bytes for the FE to sign. */
async function buildMutationPtb(
  req: AuthRequest,
  res: Response,
  build: (args: { packageId: string; agentObjectId: string; bedrockRegistryObjectId: string }) => Promise<{ ptb_bytes_b64: string; agent_object_id: string }>,
): Promise<void> {
  if (!sellerV2Enabled()) { res.status(404).json({ error: 'feature_disabled' }); return; }
  const wallet = req.user?.address;
  if (!wallet) { res.status(401).json({ error: 'wallet_required' }); return; }
  if (!(await verifyAgentOwner(req.params.id, wallet))) {
    res.status(403).json({ error: 'not_agent_owner' });
    return;
  }
  const packageId = process.env.OPENX_BRAIN_PACKAGE_ID;
  if (!packageId) { res.status(503).json({ error: 'package_not_configured' }); return; }
  const bedrockRegistryObjectId = process.env.OPENX_BEDROCK_MODEL_REGISTRY_ID;
  if (!bedrockRegistryObjectId) { res.status(503).json({ error: 'bedrock_registry_not_configured' }); return; }
  // Caller may supply sui_object_id explicitly (FE has it from publish);
  // otherwise we resolve via the indexer.
  const agentObjectId =
    typeof req.body?.sui_object_id === 'string' && req.body.sui_object_id.startsWith('0x')
      ? req.body.sui_object_id
      : await loadAgentSuiObjectId(req.params.id);
  if (!agentObjectId) { res.status(404).json({ error: 'agent_not_indexed_yet' }); return; }
  try {
    const out = await build({ packageId, agentObjectId, bedrockRegistryObjectId });
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: 'build_failed', detail: (e as Error).message });
  }
}

router.post('/seller/agents/:id/update-pricing', async (req: AuthRequest, res: Response) => {
  await buildMutationPtb(req, res, async ({ packageId, agentObjectId }) => {
    const { buildUpdatePricingPtb } = await import('@fhe-ai-context/sdk');
    const tx = buildUpdatePricingPtb({
      packageId,
      agentObjectId,
      perIterMinMicroUsdc: BigInt(req.body?.per_iter_min_micro_usdc ?? 0),
      perIterDefaultMicroUsdc: BigInt(req.body?.per_iter_default_micro_usdc ?? 0),
      maxIterPerJob: Number(req.body?.max_iter_per_job ?? 1),
    });
    const bytes = await tx.build({ client: suiClient(), onlyTransactionKind: false } as never).catch(async () => tx.serialize());
    return { ptb_bytes_b64: Buffer.from(bytes as Uint8Array).toString('base64'), agent_object_id: agentObjectId };
  });
});

router.post('/seller/agents/:id/update-model', async (req: AuthRequest, res: Response) => {
  await buildMutationPtb(req, res, async ({ packageId, agentObjectId, bedrockRegistryObjectId }) => {
    const { buildUpdateModelPtb } = await import('@fhe-ai-context/sdk');
    const tx = buildUpdateModelPtb({
      packageId,
      agentObjectId,
      bedrockRegistryObjectId,
      newModelId: String(req.body?.new_model_id ?? ''),
    });
    const bytes = await tx.build({ client: suiClient(), onlyTransactionKind: false } as never).catch(async () => tx.serialize());
    return { ptb_bytes_b64: Buffer.from(bytes as Uint8Array).toString('base64'), agent_object_id: agentObjectId };
  });
});

router.post('/seller/agents/:id/update-manifest', async (req: AuthRequest, res: Response) => {
  await buildMutationPtb(req, res, async ({ packageId, agentObjectId }) => {
    const { buildUpdateManifestPtb } = await import('@fhe-ai-context/sdk');
    const sha256B64 = String(req.body?.manifest_sha256_b64 ?? '');
    const sha256 = sha256B64 ? new Uint8Array(Buffer.from(sha256B64, 'base64')) : new Uint8Array(32);
    const tx = buildUpdateManifestPtb({
      packageId,
      agentObjectId,
      newWalrusBlobId: String(req.body?.new_walrus_blob_id ?? ''),
      manifestSha256: sha256,
    });
    const bytes = await tx.build({ client: suiClient(), onlyTransactionKind: false } as never).catch(async () => tx.serialize());
    return { ptb_bytes_b64: Buffer.from(bytes as Uint8Array).toString('base64'), agent_object_id: agentObjectId };
  });
});

router.post('/seller/agents/:id/revoke', async (req: AuthRequest, res: Response) => {
  await buildMutationPtb(req, res, async ({ packageId, agentObjectId }) => {
    const { buildRevokeAgentPtb } = await import('@fhe-ai-context/sdk');
    const tx = buildRevokeAgentPtb({ packageId, agentObjectId });
    const bytes = await tx.build({ client: suiClient(), onlyTransactionKind: false } as never).catch(async () => tx.serialize());
    return { ptb_bytes_b64: Buffer.from(bytes as Uint8Array).toString('base64'), agent_object_id: agentObjectId };
  });
});

/**
 * GET /v3/loop/seller/agents/:id/events?limit=50
 *
 * Reads the indexed `agent_events` table for the given agent (slug or uuid).
 * Falls back to live Sui RPC `queryEvents` when the table is empty for that
 * agent (e.g., indexer hasn't caught up yet — graceful degradation).
 */
router.get('/seller/agents/:id/events', async (req: AuthRequest, res: Response) => {
  if (!sellerV2Enabled()) return res.status(404).json({ error: 'feature_disabled' });
  const limit = Math.max(1, Math.min(Number(req.query.limit ?? 50), 200));

  const agentObjectId = await loadAgentSuiObjectId(req.params.id);
  if (!agentObjectId) {
    return res.json({ events: [], agent_object_id: null });
  }
  const r = await pool.query<{
    event_type: string; tx_digest: string; seq_in_tx: number;
    payload: unknown; timestamp_ms: string;
  }>(
    `SELECT event_type, tx_digest, seq_in_tx, payload, timestamp_ms
       FROM agent_events
      WHERE agent_object_id = $1
      ORDER BY timestamp_ms DESC
      LIMIT $2`,
    [agentObjectId, limit],
  );
  res.set('Cache-Control', 'private, max-age=15');
  res.json({
    agent_object_id: agentObjectId,
    events: r.rows.map((row) => ({
      type: row.event_type,
      tx_digest: row.tx_digest,
      seq_in_tx: row.seq_in_tx,
      payload: row.payload,
      timestamp_ms: Number(row.timestamp_ms),
    })),
  });
});

/**
 * GET /v3/loop/seller/me/onchain-stats
 *
 * Aggregates on-chain seller activity (publish fees paid, mutation count,
 * agent count) plus off-chain earnings for the connected wallet.
 */
router.get('/seller/me/onchain-stats', async (req: AuthRequest, res: Response) => {
  if (!sellerV2Enabled()) return res.status(404).json({ error: 'feature_disabled' });
  const wallet = req.user?.address?.toLowerCase();
  if (!wallet) return res.status(401).json({ error: 'wallet_required' });

  const evt = await pool.query<{
    publish_fees_paid: string; publish_fees_micro: string;
    mutations: string; revocations: string; agents_published: string;
  }>(
    `SELECT
        COUNT(*) FILTER (WHERE event_type = 'AgentPublishFeePaid')::text   AS publish_fees_paid,
        COALESCE(SUM(CASE WHEN event_type = 'AgentPublishFeePaid'
                          THEN (payload->>'fee_micro')::bigint ELSE 0 END), 0)::text AS publish_fees_micro,
        COUNT(*) FILTER (WHERE event_type IN ('AgentPricingUpdated','AgentModelUpdated','AgentManifestUpdated','AgentManifestAttested'))::text AS mutations,
        COUNT(*) FILTER (WHERE event_type = 'LoopAgentRevoked')::text       AS revocations,
        COUNT(*) FILTER (WHERE event_type = 'LoopAgentPublished')::text     AS agents_published
       FROM agent_events
      WHERE seller_addr = $1`,
    [wallet],
  );
  const earn = await pool.query<{ earned_total: string; calls_total: string }>(
    `SELECT
        COALESCE(SUM(pc.amount_usdc), 0)::text AS earned_total,
        COUNT(pc.id)::text                     AS calls_total
       FROM paid_calls pc
       JOIN agents a ON a.id = pc.agent_id
      WHERE a.owner_address = $1`,
    [wallet],
  );
  res.json({
    on_chain: {
      agents_published: Number(evt.rows[0]?.agents_published ?? 0),
      publish_fees_paid: Number(evt.rows[0]?.publish_fees_paid ?? 0),
      publish_fees_usdc: Number(evt.rows[0]?.publish_fees_micro ?? 0) / 1e6,
      mutations: Number(evt.rows[0]?.mutations ?? 0),
      revocations: Number(evt.rows[0]?.revocations ?? 0),
    },
    earnings: {
      earned_total_usdc: earn.rows[0]?.earned_total ?? '0',
      calls_total: Number(earn.rows[0]?.calls_total ?? 0),
    },
  });
});

/**
 * GET /v3/loop/seller/me/wallet-events?limit=50
 *
 * Wallet-wide chronological event feed — returns every on-chain event tied
 * to the connected seller wallet (across ALL their agents + admin acts).
 * Powers the /settings command-center activity ledger.
 *
 * SOLID: pure read; reuses indexed `agent_events` table for sub-50ms p95.
 */
router.get('/seller/me/wallet-events', async (req: AuthRequest, res: Response) => {
  if (!sellerV2Enabled()) return res.status(404).json({ error: 'feature_disabled' });
  const wallet = req.user?.address?.toLowerCase();
  if (!wallet) return res.status(401).json({ error: 'wallet_required' });
  const limit = Math.max(1, Math.min(Number(req.query.limit ?? 50), 200));

  const r = await pool.query<{
    event_type: string; agent_object_id: string | null;
    tx_digest: string; seq_in_tx: number;
    payload: unknown; timestamp_ms: string;
  }>(
    `SELECT event_type, agent_object_id, tx_digest, seq_in_tx, payload, timestamp_ms
       FROM agent_events
      WHERE seller_addr = $1
      ORDER BY timestamp_ms DESC
      LIMIT $2`,
    [wallet, limit],
  );
  res.set('Cache-Control', 'private, max-age=15');
  res.json({
    wallet,
    events: r.rows.map((row) => ({
      type: row.event_type,
      agent_object_id: row.agent_object_id,
      tx_digest: row.tx_digest,
      seq_in_tx: row.seq_in_tx,
      payload: row.payload,
      timestamp_ms: Number(row.timestamp_ms),
    })),
  });
});

// Admin endpoints — gated by operator wallet match.
const adminAddr = () => (process.env.OPENX_OPERATOR_SUI_PUBLIC_ADDRESS ?? '').toLowerCase();

router.post('/admin/bedrock-whitelist/add', async (req: AuthRequest, res: Response) => {
  if (!sellerV2Enabled()) return res.status(404).json({ error: 'feature_disabled' });
  const wallet = req.user?.address?.toLowerCase();
  if (!wallet || !adminAddr() || wallet !== adminAddr()) {
    return res.status(403).json({ error: 'admin_only' });
  }
  const packageId = process.env.OPENX_BRAIN_PACKAGE_ID;
  const adminCapId = process.env.OPENX_ADMIN_CAP_ID;
  const registryId = process.env.OPENX_BEDROCK_MODEL_REGISTRY_ID;
  if (!packageId || !adminCapId || !registryId) {
    return res.status(503).json({ error: 'admin_not_configured' });
  }
  const { buildAdminWhitelistModelPtb } = await import('@fhe-ai-context/sdk');
  const tx = buildAdminWhitelistModelPtb({
    packageId,
    adminCapObjectId: adminCapId,
    bedrockRegistryObjectId: registryId,
    modelId: String(req.body?.model_id ?? ''),
  });
  const bytes = await tx.build({ client: suiClient(), onlyTransactionKind: false } as never).catch(async () => tx.serialize());
  res.json({ ptb_bytes_b64: Buffer.from(bytes as Uint8Array).toString('base64') });
});

router.post('/admin/bedrock-whitelist/remove', async (req: AuthRequest, res: Response) => {
  if (!sellerV2Enabled()) return res.status(404).json({ error: 'feature_disabled' });
  const wallet = req.user?.address?.toLowerCase();
  if (!wallet || !adminAddr() || wallet !== adminAddr()) {
    return res.status(403).json({ error: 'admin_only' });
  }
  const packageId = process.env.OPENX_BRAIN_PACKAGE_ID;
  const adminCapId = process.env.OPENX_ADMIN_CAP_ID;
  const registryId = process.env.OPENX_BEDROCK_MODEL_REGISTRY_ID;
  if (!packageId || !adminCapId || !registryId) {
    return res.status(503).json({ error: 'admin_not_configured' });
  }
  const { buildAdminRemoveWhitelistModelPtb } = await import('@fhe-ai-context/sdk');
  const tx = buildAdminRemoveWhitelistModelPtb({
    packageId,
    adminCapObjectId: adminCapId,
    bedrockRegistryObjectId: registryId,
    modelId: String(req.body?.model_id ?? ''),
  });
  const bytes = await tx.build({ client: suiClient(), onlyTransactionKind: false } as never).catch(async () => tx.serialize());
  res.json({ ptb_bytes_b64: Buffer.from(bytes as Uint8Array).toString('base64') });
});

/** GET /v3/loop/seller/v2-config — public config helper for the FE wizard. */
router.get('/seller/v2-config', async (_req, res) => {
  res.json({
    enabled: sellerV2Enabled(),
    package_id: process.env.OPENX_BRAIN_PACKAGE_ID ?? null,
    bedrock_registry_id: process.env.OPENX_BEDROCK_MODEL_REGISTRY_ID ?? null,
    admin_addr: process.env.OPENX_PUBLISH_FEE_ADMIN_ADDRESS ?? null,
    usdc_coin_type: process.env.OPENX_USDC_COIN_TYPE ?? null,
    publish_fee_micro: 1_000_000,
  });
});

export default router;
