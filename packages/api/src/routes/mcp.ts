/**
 * HTTP transport for the OpenX MCP server (Sui-only).
 *
 * Single Express POST /mcp accepts a JSON-RPC 2.0 request (or batch).
 * Mounted from server.ts. Dispatch lives in `@fhe-ai-context/sdk/mcp/server`.
 *
 * Auth: optional. The MCP spec allows unauthenticated tool listing; the
 * paid tools' 402 envelope is the paywall (-32402 JSON-RPC error code).
 */

import { Router, type Request, type Response } from 'express';
import { OpenXMcpServer, type OpenXClient } from '@fhe-ai-context/sdk';
import { logger } from '../lib';

const router = Router();

const openxClient: OpenXClient = {
  apiUrl: process.env.OPENX_API_URL ?? 'http://localhost:3001',
  walletAddress: process.env.PLATFORM_WALLET ?? undefined,
};

const server = new OpenXMcpServer(openxClient, {
  payTo: process.env.OPENX_PLATFORM_PAYTO ?? process.env.PLATFORM_WALLET ?? '',
  pricePerCall: process.env.OPENX_PRICE_PER_QUERY ?? '0.01',
  publicUrl: process.env.OPENX_MCP_PUBLIC_URL ?? 'https://api.openx.so/mcp',
  authMode: 'openx-bound',
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const out = await server.dispatch(req.body);
    if (out === null) return res.status(204).end();
    res.json(out);
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'mcp:dispatch:error');
    res.status(500).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32603, message: 'Internal error' },
    });
  }
});

router.get('/healthz', (_req, res) => res.json({ ok: true, server: 'openx-mcp' }));

export default router;
