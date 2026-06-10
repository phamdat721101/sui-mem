/**
 * MCP tool registry — declarative list. Adding a tool = appending one entry.
 *
 * Sui-only after the EVM/Fhenix pivot. The handlers call back to the OpenX
 * API by HTTP; the MCP gateway holds the buyer's wallet context and forwards
 * `x-wallet-address` so the API enforces ownership/payment per the existing
 * server-side gates (requireSuiWallet, paymentGate, /v3/memory/*).
 *
 * SOLID:
 *  - SRP: tool definitions + a single `apiFetch` helper.
 *  - DI: the lightweight `OpenXClient` shape carries `apiUrl` + `walletAddress`
 *    from the server (`mcp/server.ts`) so handlers don't reach into env.
 *  - OCP: a new tool = append one record.
 */

export interface OpenXClient {
  apiUrl: string;
  walletAddress?: string;
}

export type MemoryId = `${string}/${string}`;

export interface PaymentEnvelope {
  rail: 'sui_usdc';
  amount_usdc: string;
  pay_to: string;
  endpoint: string;
  tool: string;
}

export interface ToolHandlerCtx {
  openx: OpenXClient;
  args: Record<string, unknown>;
  callerAddress?: string;
}

export type ToolHandler = (ctx: ToolHandlerCtx) => Promise<unknown>;

export interface ToolMeta {
  name: string;
  description: string;
  paid: boolean;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  _meta?: Record<string, unknown>;
}

export interface ToolDef extends ToolMeta {
  handler: ToolHandler;
}

const tStr = { type: 'string' };
const tInt = { type: 'integer' };

export const TOOLS: ToolDef[] = [
  // ─── MemWal-tier tools ────────────────────────────────────────────────
  {
    name: 'memwal_marketplace_list',
    description: 'List paid MemWal-tier brains. Filters: cognitive_level (1–5), max_price_usdc, kya, q.',
    paid: false,
    inputSchema: {
      type: 'object',
      properties: { cognitive_level: tInt, max_price_usdc: { type: 'number' }, kya: tStr, q: tStr },
    },
    handler: ({ openx, args }) => apiFetch(openx, '/v3/memory/marketplace', 'GET', undefined, args),
  },
  {
    name: 'memwal_marketplace_query',
    description:
      'Paid recall against a published MemWal brain. Returns recall results + three-proof attestation (Phala/Sui/Walrus).',
    paid: true,
    inputSchema: {
      type: 'object',
      properties: { brain_id: tStr, query: tStr, limit: tInt, min_relevance: { type: 'number' } },
      required: ['brain_id', 'query'],
    },
    _meta: { 'x-x402': { method: 'sui-usdc', currency: 'USDC' } },
    handler: ({ openx, args }) =>
      apiFetch(openx, `/v3/memory/brain/${args.brain_id}/query`, 'POST', {
        query: args.query,
        limit: args.limit,
        minRelevance: args.min_relevance,
      }),
  },
  {
    name: 'memwal_remember',
    description: 'Store text in the caller-owned MemWalAccount.',
    paid: false,
    inputSchema: {
      type: 'object',
      properties: { text: tStr, namespace: tStr },
      required: ['text'],
    },
    handler: ({ openx, args }) =>
      apiFetch(openx, '/v3/memory/remember', 'POST', { text: args.text, namespace: args.namespace }),
  },
  {
    name: 'memwal_recall',
    description: 'Semantic recall against the caller-owned MemWalAccount.',
    paid: false,
    inputSchema: {
      type: 'object',
      properties: { query: tStr, namespace: tStr, limit: tInt, min_relevance: { type: 'number' } },
      required: ['query'],
    },
    handler: ({ openx, args }) =>
      apiFetch(openx, '/v3/memory/recall', 'POST', {
        query: args.query,
        namespace: args.namespace,
        limit: args.limit,
        minRelevance: args.min_relevance,
      }),
  },
  {
    name: 'memwal_analyze',
    description:
      'LLM-extract facts from a longer text and bulk-store them under the caller-owned MemWalAccount.',
    paid: false,
    inputSchema: {
      type: 'object',
      properties: { text: tStr, namespace: tStr },
      required: ['text'],
    },
    handler: ({ openx, args }) =>
      apiFetch(openx, '/v3/memory/analyze', 'POST', { text: args.text, namespace: args.namespace }),
  },
  {
    name: 'memwal_restore',
    description:
      'Rebuild the relayer index for one of the caller-owned namespaces from Walrus alone (sovereignty op).',
    paid: false,
    inputSchema: {
      type: 'object',
      properties: { namespace: tStr, limit: tInt },
      required: ['namespace'],
    },
    handler: ({ openx, args }) =>
      apiFetch(openx, '/v3/memory/restore', 'POST', { namespace: args.namespace, limit: args.limit }),
  },
  {
    name: 'openx_memwal_publish',
    description:
      'Cache the metadata of a MemWalBrain Sui object after the seller has submitted the on-chain publish_brain tx. Idempotent on suiObjectId.',
    paid: false,
    inputSchema: {
      type: 'object',
      properties: {
        suiObjectId: tStr,
        memwalAccountId: tStr,
        namespace: tStr,
        title: tStr,
        description: tStr,
        pricePerQueryUsdc: tStr,
        kyaRequired: { type: 'boolean' },
        attestationRequired: tInt,
        cognitiveLevel: tInt,
        sovereigntyProofUrl: tStr,
      },
      required: ['suiObjectId', 'memwalAccountId', 'namespace', 'title'],
    },
    handler: ({ openx, args }) => apiFetch(openx, '/v3/memory/marketplace/publish', 'POST', args),
  },
];

// ─── HTTP helper — single function, single concern, uniform error envelope ───

async function apiFetch(
  openx: OpenXClient,
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
  query?: Record<string, unknown>,
): Promise<unknown> {
  const url = new URL(path, openx.apiUrl || 'http://localhost:3001');
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  const headers: Record<string, string> = { 'x-chain': 'sui' };
  if (openx.walletAddress) headers['x-wallet-address'] = openx.walletAddress;
  if (body) headers['Content-Type'] = 'application/json';
  const r = await fetch(url.toString(), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json: unknown = {};
  if (text) {
    try { json = JSON.parse(text); } catch { json = { error: text.slice(0, 200) }; }
  }
  if (!r.ok) {
    const j = json as { error?: string; message?: string };
    const err = new Error(j?.message ?? j?.error ?? `HTTP ${r.status}`) as Error & {
      code?: string;
      status?: number;
    };
    err.code = j?.error;
    err.status = r.status;
    throw err;
  }
  return json;
}
