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
import {
  logger,
  correlationId,
  metricsMiddleware,
  metricsHandler,
  healthHandler,
  installLifecycle,
} from './lib';

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
