/**
 * cognitive/namespaces.ts — single source of truth for the cognitive L1–L5
 * MemWal namespace convention (PRD-10).
 *
 * Pattern:  `cog-l{N}-{brainId}[-{sessionId}]`
 *
 *   L1 episodic     → cog-l1-<brainId>-<sessionId>   (sessionId REQUIRED)
 *   L2 semantic     → cog-l2-<brainId>
 *   L3 long-term    → cog-l3-<brainId>
 *   L4 workflow     → cog-l4-<brainId>
 *   L5 reflective   → cog-l5-<brainId>
 *
 * Why this lives in one file:
 *   • String formatting + parsing is centralized — no `cog-l${level}-` template
 *     literals are allowed anywhere else in the codebase.
 *   • Dual-write (cognitiveMemoryService → Postgres + MemWal) calls
 *     `cogNamespace()` so MemWal blobs are automatically grouped by level.
 *   • The marketplace publish flow (PRD-08) reads `cognitive_level` and
 *     re-derives the namespace — never persists it as a free-form string.
 *
 * SOLID: this module is pure (no I/O), so it's safe to import everywhere
 * (frontend, api, worker, scripts).
 */

export type CognitiveLevel = 1 | 2 | 3 | 4 | 5;

export const COGNITIVE_LEVEL_LABELS: Record<CognitiveLevel, string> = {
  1: 'episodic',
  2: 'semantic',
  3: 'long-term',
  4: 'workflow',
  5: 'reflective',
};

/** Default per-query price defaults (USDC) per cognitive level — used by
 *  the publish wizard to pre-fill `price_per_query_usdc`. Sellers override. */
export const COGNITIVE_DEFAULT_PRICES_USDC: Record<CognitiveLevel, string> = {
  1: '0.005',
  2: '0.01',
  3: '0.05',
  4: '0.50',
  5: '5.00',
};

/**
 * Build the canonical MemWal namespace for a (level, brainId[, sessionId]) triple.
 * Throws when L1 is requested without a sessionId — `cog-l1-<brainId>` would
 * leak the per-session boundary that L1 episodic memory depends on.
 */
export function cogNamespace(
  level: CognitiveLevel,
  brainId: string,
  sessionId?: string,
): string {
  if (!brainId) throw new Error('cogNamespace: brainId required');
  if (level === 1) {
    if (!sessionId) throw new Error('cogNamespace: L1 episodic requires sessionId');
    return `cog-l1-${brainId}-${sessionId}`;
  }
  return `cog-l${level}-${brainId}`;
}

/**
 * Inverse — parses a namespace string back into the level/brainId/sessionId
 * triple. Returns `null` when the string doesn't match the schema, so callers
 * can treat malformed input as "not a cognitive namespace" rather than throw.
 */
export function parseCogNamespace(
  ns: string,
): { level: CognitiveLevel; brainId: string; sessionId?: string } | null {
  const m = /^cog-l([1-5])-(.+?)(?:-([^-]+))?$/.exec(ns);
  if (!m) return null;
  const level = Number(m[1]) as CognitiveLevel;
  const brainId = m[2];
  const sessionId = m[3];
  if (level === 1 && !sessionId) return null;
  return { level, brainId, sessionId };
}

/**
 * PRD-W6 — runtime guard used by `namespaceDelegateService.resolveSeller`.
 *
 * Returns `true` iff `ns` is a cognitive namespace at L2..L5 that belongs to
 * the given `agentOrBrainId`. The seller-namespace delegate key (W6 role
 * `seller-namespace`) is allowed to sign MemWal writes only when this
 * predicate fires `true`. L1 is rejected because L1 episodic is process-local
 * and never delegate-signed.
 *
 * Pure: no I/O. Reuses `parseCogNamespace` so the regex remains the single
 * source of truth (PRD-10 invariant).
 */
export function isCogNamespaceForAgent(ns: string, agentOrBrainId: string): boolean {
  if (!agentOrBrainId) return false;
  const parsed = parseCogNamespace(ns);
  if (!parsed) return false;
  if (parsed.level === 1) return false; // L1 is per-session, not delegate-signed
  return parsed.brainId === agentOrBrainId;
}

/**
 * PRD-W6 — namespace pattern stored on `memwal_delegate_keys.cog_namespace_pattern`.
 * Used as a documentation string in Postgres + as the input to
 * `isCogNamespaceForAgent` at runtime. Format: `cog-l[2345]-{agentId}`.
 */
export function cogNamespacePatternForAgent(agentOrBrainId: string): string {
  if (!agentOrBrainId) throw new Error('cogNamespacePatternForAgent: agentOrBrainId required');
  return `cog-l[2345]-${agentOrBrainId}`;
}

/**
 * Dual-write contract — used by `cognitiveMemoryService` and any future
 * surface that wants to mirror a Postgres-stored cognitive memory into
 * MemWal in the background.
 *
 * The actual mirror is fire-and-forget: callers enqueue a job; a BullMQ
 * worker picks it up and calls `OpenXMemWalAdapter.remember(text, ns)`.
 * This interface keeps the service-layer code free of MemWal coupling
 * (DIP) — pass any function that satisfies the shape.
 */
export interface CognitiveMirror {
  enqueue(args: {
    level: CognitiveLevel;
    brainId: string;
    sessionId?: string;
    text: string;
    /** Postgres row id — set on the row after MemWal write succeeds. */
    postgresRowId: string | number;
  }): Promise<void>;
}

/** No-op mirror — used when the worker isn't running (dev / tests). */
export const noopCognitiveMirror: CognitiveMirror = {
  enqueue: async () => undefined,
};
