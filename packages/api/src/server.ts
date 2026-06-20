import path from 'node:path';
import dotenv from 'dotenv';

// Load env deterministically regardless of cwd. npm workspaces flips cwd to
// the package, so a plain `dotenv.config()` would miss the repo-root .env.
// Resolution order (first hit wins; later files do NOT override earlier keys):
//   1. packages/api/.env   — package-local override (CI / Docker)
//   2. <repo-root>/.env    — workspace-wide canonical config
// SOLID: one swap-point — adding a third source = one entry.
for (const envPath of [
  path.resolve(__dirname, '../.env'),
  path.resolve(__dirname, '../../../.env'),
]) {
  dotenv.config({ path: envPath, override: false });
}

import express from 'express';
import cors from 'cors';
import { auth } from './middleware/auth';
import v3MemoryRouter from './routes/v3-memory';
import v3MarketplaceRouter from './routes/v3-marketplace';
import v3LoopRouter from './routes/v3-loop';
import v3AgentsRouter from './routes/v3-agents';
import v1PublicRouter from './routes/v1Public';
import mcpRouter from './routes/mcp';
import { errorHandler } from './lib/routerSafety';
import {
  logger,
  correlationId,
  metricsMiddleware,
  metricsHandler,
  healthHandler,
  installLifecycle,
} from './lib';
import { pool } from './db';
import { PersonaAutoRewriteCron, type ScheduledCron } from './services/loop/personaAutoRewrite';
import { DailyArchivalPassCron } from './services/loop/dailyArchivalPass';
import { WeeklyDigestCron } from './services/loop/weeklyDigestCron';
import { ArtifactVaultService } from './services/loop/artifactVaultService';
import { MemoryService } from './services/loop/memoryService';
import {
  WorkflowDispatcher,
  validateWorkflow,
} from './services/loop/workflowDispatcher';
import { OutcomeEvaluator } from './services/loop/outcomeEvaluator';
import { StopConditionEvaluator } from './services/loop/stopConditionEvaluator';
import { MockStepExecutor } from './services/loop/mockStepExecutor';
import {
  WorkflowSchedulerCron,
  type SubscriptionRunner,
  type DueSubscription,
} from './services/loop/workflowScheduler';
import { recordWorkflowRunSideEffects } from './services/loop/workflowRunRecorder';
import { AgentEventIndexerCron } from './services/loop/agentEventIndexer';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { getOpenXMemWalMirror } from './services/memwalMirror';

/**
 * OpenX API — Sui-native after the EVM/Fhenix pivot.
 *
 * Surface:
 *   GET  /health                          dependency probes
 *   GET  /metrics                         Prometheus
 *   GET  /v3/memory/marketplace           public catalog of MemWal brains
 *   GET  /v3/memory/brain/:id             public brain detail
 *   GET  /v3/memory/brain/:id/sovereignty-proof  Walrus-only restore proof
 *   POST /v3/memory/brain/:id/query       paid recall (sui_usdc)
 *   POST /v3/memory/remember              caller-owned MemWalAccount write
 *   POST /v3/memory/recall                caller-owned MemWalAccount read
 *   POST /v3/memory/restore               sovereignty op
 *   POST /v3/memory/analyze               LLM-extract facts + bulk store
 *   GET  /v3/memory/operator/stats        seller earnings
 *   GET  /v3/marketplace/listings         public agent catalog
 *   POST /v3/marketplace/seller/publish   atomic seller publish
 *   POST /mcp                             MCP JSON-RPC 2.0 gateway
 *
 * Mount order: parsing → correlationId → metrics → public surface →
 * authed surface. Auth is wallet-address based; per-route Sui gating
 * lives inside the routers (`requireSuiWallet` on writes).
 */

const app = express();
app.use(cors());
app.use(correlationId());
app.use(metricsMiddleware());
app.use(express.json({ limit: '2mb' }));

// Public diagnostics
app.get('/health', healthHandler);
app.get('/metrics', metricsHandler);

// /api/v1/<slug> — public AI-buyer paywall (the paywall IS the auth).
// Mounted BEFORE the global `auth` middleware so /api/v1/* never sees it.
app.use('/api/v1', v1PublicRouter);

// /v3/memory — Sui-native MemWal product (the heart of OpenX).
app.use('/v3/memory', auth, v3MemoryRouter);

// /v3/marketplace — public catalog + seller publish.
app.use('/v3/marketplace', auth, v3MarketplaceRouter);

// /v3/agents — buyer workspace endpoints. Public surface (no auth needed —
// the agent paywall middleware gates the paid /try path; free /try uses
// per-IP rate limits).
app.use('/v3/agents', v3AgentsRouter);

// /v3/loop — Sui-native loop marketplace (Mode A x402 fast lane + Mode B
// loop hire). Auth allows public reads via PUBLIC_PATHS in middleware/auth.ts.
app.use('/v3/loop', auth, v3LoopRouter);

// /mcp — MCP JSON-RPC 2.0 gateway. Public; the -32402 envelope on paid
// tools is the paywall.
app.use('/mcp', mcpRouter);

// Global error handler — MUST be last in the middleware chain. Maps Postgres
// data-validity errors, Sui x402 / sponsor errors, and http-status-bearing
// errors to clean structured responses. Hardens every route attached via
// hardenedRouter() against process crashes from async-handler throws.
app.use(errorHandler);

const PORT = Number(process.env.PORT ?? 3001);

// Boot-time env validation — fail fast with a clear message.
const REQUIRED = ['DATABASE_URL'];
const missing = REQUIRED.filter((v) => !process.env[v]);
if (missing.length) {
  logger.error({ missing }, 'Missing required env vars — exiting');
  process.exit(1);
}

const server = app.listen(PORT, () => logger.info({ port: PORT }, 'api:listening'));
installLifecycle(server);

// ─── Cron runner — single-threaded UTC heartbeat ─────────────────────────
//
// One setInterval ticks every 30s; we de-dupe within the same UTC minute so
// each cron fires at most once per day at its `utc_minute`. Each cron's
// `enabled()` predicate checks its feature flag at tick time so flips in
// `.env` take effect on the next minute without restart.
//
// SOLID-LSP: every cron implements `ScheduledCron`; adding a new one = one
// `crons.push(new …Cron(…))` line below.

// PRD-X1 — replaces the legacy `{ remember: async () => null }` placeholder.
// `getOpenXMemWalMirror()` returns the live OpenXMemWalAdapter-backed
// mirror when FEATURE_LOOP_MIRROR_LIVE=true, otherwise a no-op singleton
// (byte-identical to legacy behavior). See services/memwalMirror.ts.
const noopMirror = getOpenXMemWalMirror();

const personaSynth = {
  /**
   * Phala-backed persona synthesizer. Returns a 1-line proposal blob + a
   * short reasoning string. Lazy-imports the Phala client so module load
   * stays cheap when the flag is off.
   */
  synthesize: async (args: { agent_id: string; reflections: string[] }) => {
    const { createPhalaClient } = await import('@fhe-ai-context/sui-sdk');
    const phala = createPhalaClient();
    const r = await phala.infer([
      {
        role: 'system',
        content:
          'You are a persona synthesizer. Given recent agent reflections, propose a brief delta to the persona system prompt that addresses the most-cited weakness. Output JSON: {"delta_md": "...", "reasoning": "..."}',
      },
      { role: 'user', content: JSON.stringify({ agent_id: args.agent_id, reflections: args.reflections.slice(0, 20) }) },
    ]);
    let parsed: { delta_md?: string; reasoning?: string } = {};
    try { parsed = JSON.parse(r.answer); } catch { parsed = { delta_md: r.answer.slice(0, 1000), reasoning: 'plain text' }; }
    return {
      blob: new TextEncoder().encode(parsed.delta_md ?? ''),
      reasoning: (parsed.reasoning ?? '').slice(0, 500),
    };
  },
};

const digestLLM = {
  infer: async (messages: Array<{ role: 'system' | 'user'; content: string }>) => {
    const { createPhalaClient } = await import('@fhe-ai-context/sui-sdk');
    const phala = createPhalaClient();
    const r = await phala.infer(messages);
    return { answer: r.answer };
  },
};

let _digestVault: ArtifactVaultService | null = null;
const digestVault = () =>
  (_digestVault ??= new ArtifactVaultService({ pool, mirror: noopMirror, logger }));

const digestWalrus = {
  upload: async (bytes: Uint8Array) => {
    const { createWalrusStore } = await import('@fhe-ai-context/sui-sdk');
    return createWalrusStore().upload(bytes);
  },
};

/**
 * SubscriptionRunner — concrete implementation of the previously-orphaned
 * interface from workflowScheduler.ts. For each due subscription:
 *   1. load the agent's saved workflow YAML (latest cognitive_memories row
 *      under namespace `workflow-yaml-{agent_id}`)
 *   2. run it through the same WorkflowDispatcher as instant runs
 *   3. record side effects (paid_calls + workflow_runs + vault deposit)
 *
 * Same dispatcher path as /run-workflow → no duplication. The synthetic
 * tx_hash `cron:sub-{id}-{job_id}` keeps paid_calls.UNIQUE happy and lets
 * the studio show "X runs subscribed" cleanly per run.
 */
function buildSubscriptionRunner(): SubscriptionRunner {
  const memory = new MemoryService({ pool, mirror: noopMirror, logger });
  const vault = new ArtifactVaultService({ pool, mirror: noopMirror, logger });
  const outcome = new OutcomeEvaluator(new StopConditionEvaluator({ pool, logger }), logger);
  const executor = new MockStepExecutor();

  return {
    async forkAndRun(sub: DueSubscription): Promise<{ job_id: string }> {
      // 1. Load the workflow YAML for this agent.
      const wfRow = await pool.query<{ text: string; agent_pkid: string }>(
        `SELECT cm.text AS text, a.id::text AS agent_pkid
           FROM cognitive_memories cm
           JOIN agents a ON (a.slug = $1 OR a.id::text = $1)
          WHERE cm.namespace IN ('workflow-yaml-' || a.slug, 'workflow-yaml-' || a.id::text)
          ORDER BY cm.created_at DESC LIMIT 1`,
        [sub.agent_id],
      );
      if (!wfRow.rowCount) {
        throw new Error(`scheduler: no workflow saved for agent ${sub.agent_id}`);
      }
      const workflow = validateWorkflow(JSON.parse(wfRow.rows[0].text));
      const agent_pkid = wfRow.rows[0].agent_pkid;

      // 2. Run the dispatcher (same path as instant runs).
      const job_id = `sub-${sub.id}-${Date.now()}`;
      const buyer_input = { request: 'daily-recurring run', topic: sub.area_slug ?? '' };
      const dispatcher = new WorkflowDispatcher(memory, outcome, executor, logger);
      const result = await dispatcher.run({
        workflow,
        agent_id: sub.agent_id,
        buyer_addr: sub.buyer_addr,
        job_id,
        buyer_input,
        area_slug: sub.area_slug ?? undefined,
        budget_micro: Number(sub.max_per_run_micro) || 25_000_000,
      });

      // 3. Record side effects (paid_calls + workflow_runs + vault deposit).
      await recordWorkflowRunSideEffects(
        { pool, vault, walrus: digestWalrus, logger },
        {
          result,
          agent_id: sub.agent_id,
          agent_pkid,
          buyer_addr: sub.buyer_addr,
          request: buyer_input.request,
          job_id,
          area_slug: sub.area_slug ?? null,
          workflow_walrus_blob_id: sub.template_walrus_blob_id ?? null,
          payment: {
            // Subscriptions prepay budget on-chain — credit the seller per fork
            // using the configured max_per_run_micro as the realized amount.
            amount_usdc: (Number(sub.max_per_run_micro) / 1_000_000).toFixed(6),
            tx_hash: `cron:${sub.subscription_object_id}:${job_id}`,
            network: process.env.SUI_NETWORK ?? 'sui-testnet',
            method: 'sui_usdc',
          },
        },
      );

      return { job_id };
    },
  };
}

const crons: ScheduledCron[] = [
  new PersonaAutoRewriteCron({
    pool,
    llm: personaSynth,
    mirror: noopMirror,
    logger,
    enabled: () => process.env.FEATURE_LOOP_W3_PERSONA_AUTO_REWRITE === 'true',
  }),
  new DailyArchivalPassCron({
    pool,
    logger,
    enabled: () => process.env.FEATURE_LOOP_W3_PARA_ARCHIVAL === 'true',
  }),
  new WeeklyDigestCron({
    pool,
    vault: digestVault(),
    walrus: digestWalrus,
    llm: digestLLM,
    logger,
    enabled: () => process.env.FEATURE_WEEKLY_DIGEST === 'true',
  }),
  new WorkflowSchedulerCron({
    pool,
    runner: buildSubscriptionRunner(),
    logger,
    enabled: () => process.env.FEATURE_LOOP_DAILY_RUN === 'true',
  }),
  new AgentEventIndexerCron({
    pool,
    suiClient: new SuiClient({ url: process.env.SUI_RPC_URL ?? getFullnodeUrl('testnet') }),
    packageId: () => process.env.OPENX_BRAIN_PACKAGE_ID,
    logger,
    enabled: () => process.env.FEATURE_LOOP_SELLER_V2 === 'true',
  }),
];

let lastTickMinute = -1;
const cronTimer = setInterval(async () => {
  const now = new Date();
  const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (minute === lastTickMinute) return;
  lastTickMinute = minute;
  for (const c of crons) {
    // Some crons fire every minute and self-filter internally (workflow
    // scheduler reads next_run_ts; event indexer pulls from a cursor).
    // All other crons fire only at their specific utc_minute-of-day.
    const everyMinute = c.name === 'workflowScheduler' || c.name === 'agentEventIndexer';
    if (!everyMinute && c.utc_minute !== minute) continue;
    try {
      await c.tick(now);
    } catch (e) {
      logger.error({ cron: c.name, err: (e as Error).message }, 'cron:tick_failed');
    }
  }
}, 30_000);
cronTimer.unref();
