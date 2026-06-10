/**
 * OpenX MCP server — JSON-RPC 2.0 (protocol `2025-11-25`) dispatch layer.
 *
 * Pure logic, no transport. Wrap with HTTP (`packages/api/src/routes/mcp.ts`)
 * for hosted (`api.openx.so/mcp`) or with stdio (Phase 4 `@openx/mcp` shim
 * package) for Claude Desktop subprocess use. Same dispatch handles both.
 *
 * SOLID:
 * - SRP: only does JSON-RPC 2.0 envelope handling + tool dispatch. The tools
 *   themselves are declarative records in `tools.ts`.
 * - DI: tool handlers + OpenXClient injected via constructor. Tests pass mocks.
 *
 * Custom error code: `-32402` (`JSONRPC_PAYMENT_REQUIRED`) carries an x402
 * envelope on paid tool calls. Matches the n-payment v0.16 ecosystem
 * convention so MCP-aware agent hosts can handle pay-then-retry uniformly.
 */

import { TOOLS, type ToolHandler, type PaymentEnvelope, type OpenXClient } from './tools';

export const MCP_PROTOCOL_VERSION = '2025-11-25';
export const JSONRPC_PAYMENT_REQUIRED = -32402;

/**
 * OpenX MCP gateway error codes (PRD-09b §9). Adding a code = one entry here +
 * one row in `MCP_ERROR_FROM_HTTP` below. Tools that throw an Error with a
 * matching `code` field (set by `memwalFetch`) are auto-translated.
 */
export const OpenXMcpErrorCode = {
  AuthRequired: -32000,
  RateLimit: -32001,
  PaymentDenied: -32002,
  Upstream401: -32003,
  Upstream503: -32004,
  AccountFrozen: -32005,
  StorageQuota: -32006,
  KyaRequired: -32007,
  InvalidInput: -32008,
  CompatMismatch: -32009,
} as const;

/** Map OpenXMemWal* error codes (from `memwalFetch` JSON envelope) → JSON-RPC. */
const MCP_ERROR_FROM_MEMWAL: Record<string, number> = {
  OPENX_MEMWAL_UPSTREAM_MISSING: OpenXMcpErrorCode.Upstream503,
  OPENX_MEMWAL_COMPATIBILITY_MISMATCH: OpenXMcpErrorCode.CompatMismatch,
  OPENX_MEMWAL_PAYMENT_DENIED: OpenXMcpErrorCode.PaymentDenied,
  OPENX_MEMWAL_RATE_LIMIT: OpenXMcpErrorCode.RateLimit,
  OPENX_MEMWAL_ACCOUNT_FROZEN: OpenXMcpErrorCode.AccountFrozen,
  OPENX_MEMWAL_NO_ACCESS: OpenXMcpErrorCode.AccountFrozen,
  OPENX_MEMWAL_STORAGE_QUOTA: OpenXMcpErrorCode.StorageQuota,
  OPENX_MEMWAL_INVALID_CONFIG: OpenXMcpErrorCode.InvalidInput,
  OPENX_MEMWAL_UPSTREAM_ERROR: OpenXMcpErrorCode.Upstream503,
};

/** Map raw HTTP status codes (from `memwalFetch`) → JSON-RPC. */
const MCP_ERROR_FROM_HTTP: Record<number, number> = {
  400: OpenXMcpErrorCode.InvalidInput,
  401: OpenXMcpErrorCode.Upstream401,
  402: OpenXMcpErrorCode.PaymentDenied,
  403: OpenXMcpErrorCode.AccountFrozen,
  413: OpenXMcpErrorCode.StorageQuota,
  426: OpenXMcpErrorCode.CompatMismatch,
  429: OpenXMcpErrorCode.RateLimit,
  503: OpenXMcpErrorCode.Upstream503,
};

/**
 * Translate any thrown error into a JSON-RPC code + message. Three layers,
 * checked in order: explicit MemWal code → HTTP status → generic -32603.
 */
function jsonRpcCodeFor(e: unknown): { code: number; message: string; data?: unknown } {
  const ex = e as { code?: string; status?: number; message?: string; retryAfterMs?: number };
  if (ex?.code && MCP_ERROR_FROM_MEMWAL[ex.code] !== undefined) {
    return {
      code: MCP_ERROR_FROM_MEMWAL[ex.code],
      message: ex.message ?? ex.code,
      data: ex.retryAfterMs != null ? { retry_after_ms: ex.retryAfterMs } : undefined,
    };
  }
  if (typeof ex?.status === 'number' && MCP_ERROR_FROM_HTTP[ex.status] !== undefined) {
    return { code: MCP_ERROR_FROM_HTTP[ex.status], message: ex.message ?? `HTTP ${ex.status}` };
  }
  return { code: -32603, message: `Internal error: ${ex?.message ?? String(e)}` };
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown> & {
    name?: string;
    arguments?: Record<string, unknown>;
    _meta?: { callerAddress?: string; payment?: unknown };
  };
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpServerConfig {
  /** Wallet address that receives paid-query proceeds. */
  payTo: string;
  /** USDC price per paid tool call (string, e.g. "0.01"). */
  pricePerCall: string;
  /** Public URL the buyer should retry against after paying. */
  publicUrl: string;
  /**
   * Auth-mode selector (PRD-09 §5). Default = `openx-bound`.
   *  - `openx-bound`   → all MemWal calls route through OpenX API.
   *                      Operator pool holds delegate keys; buyer never
   *                      sees them. Best for hosted clients.
   *  - `memwal-direct` → tools call MemWal relayer directly using the
   *                      user's `~/.memwal/credentials.json`. Bypasses
   *                      OpenX entirely; suits power users.
   *  - `hybrid`        → tool-prefix routing: `memwal_*` direct,
   *                      `openx_memwal_*` through OpenX bearer.
   *
   * The current MemWal tool handlers always go through OpenX API — that
   * is the authoritative `openx-bound` path. `memwal-direct` and `hybrid`
   * are surfaced as configuration today; the in-tool routing branch lands
   * in T22 once the credentials-file lifecycle (T23 wizard) is wired.
   */
  authMode?: 'openx-bound' | 'memwal-direct' | 'hybrid';
}

export class OpenXMcpServer {
  constructor(
    private readonly openx: OpenXClient,
    private readonly cfg: McpServerConfig,
  ) {}

  /**
   * Stateless handler. Accepts a JSON-parsed body (single request or batch),
   * returns the response(s) as plain objects. Transport is the caller's job.
   */
  async dispatch(body: JsonRpcRequest | JsonRpcRequest[]): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
    if (Array.isArray(body)) {
      const out = await Promise.all(body.map((r) => this.dispatchOne(r)));
      return out.filter(Boolean) as JsonRpcResponse[];
    }
    return this.dispatchOne(body);
  }

  private async dispatchOne(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const id = req.id ?? null;
    try {
      switch (req.method) {
        case 'initialize':
          return ok(id, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'openx-mcp', version: '1.0.0' },
          });
        case 'tools/list':
          return ok(id, { tools: TOOLS.map(({ handler: _h, ...meta }) => meta) });
        case 'tools/call':
          return await this.handleToolCall(req);
        case 'ping':
          return ok(id, {});
        case 'notifications/initialized':
        case 'notifications/cancelled':
          // Notifications don't expect a response.
          return null;
        default:
          return err(id, -32601, `Method not found: ${req.method}`);
      }
    } catch (e) {
      const { code, message, data } = jsonRpcCodeFor(e);
      return err(id, code, message, data);
    }
  }

  private async handleToolCall(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    const id = req.id ?? null;
    const name = req.params?.name;
    const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
    const meta = req.params?._meta ?? {};
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return err(id, -32601, `Unknown tool: ${name}`);

    if (tool.paid && !meta.payment) {
      const envelope: PaymentEnvelope = {
        rail: 'sui_usdc',
        amount_usdc: this.cfg.pricePerCall,
        pay_to: this.cfg.payTo,
        endpoint: this.cfg.publicUrl,
        tool: tool.name,
      };
      return err(id, JSONRPC_PAYMENT_REQUIRED, 'Payment required', { paymentRequired: envelope });
    }

    const handler = tool.handler as ToolHandler;
    try {
      const result = await handler({ openx: this.openx, args, callerAddress: meta.callerAddress });
      return ok(id, buildToolCallResult(tool.name, result));
    } catch (e) {
      const { code, message, data } = jsonRpcCodeFor(e);
      return err(id, code, message, data);
    }
  }
}

/**
 * Build the MCP `tools/call` result envelope.
 *
 * For paid MemWal-tier responses (the brain-query path returns
 * `{ results, attestation, billing, ... }`) we surface the attestation +
 * billing blocks as structured `_meta` annotations alongside the canonical
 * text payload — that lets MCP hosts (Cursor, Claude Desktop) render the
 * three-proof links inline without parsing JSON.
 *
 * Plain results pass through unchanged so non-MemWal tools (e.g.
 * `openx_brain_search`) keep their existing wire format.
 */
function buildToolCallResult(toolName: string, result: unknown): {
  content: Array<{ type: 'text'; text: string }>;
  _meta?: Record<string, unknown>;
} {
  const out: { content: Array<{ type: 'text'; text: string }>; _meta?: Record<string, unknown> } = {
    content: [{ type: 'text', text: JSON.stringify(result) }],
  };
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    const att = r.attestation;
    const bill = r.billing;
    if (att || bill) {
      out._meta = {
        tool: toolName,
        ...(att ? { attestation: att } : {}),
        ...(bill ? { billing: bill } : {}),
      };
    }
  }
  return out;
}

function ok(id: JsonRpcResponse['id'], result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function err(
  id: JsonRpcResponse['id'],
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}
