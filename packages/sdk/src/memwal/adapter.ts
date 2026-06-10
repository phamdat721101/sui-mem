/**
 * memwal/adapter.ts — `OpenXMemWalAdapter`, the single supported way OpenX
 * code talks to Walrus Memory.
 *
 * SOLID
 * -----
 *  - SRP: this file owns ONE class. Round-robin pool + peer-dep loader are
 *    inlined as private helpers (each <30 lines, single concern).
 *  - DIP: every collaborator (Redis, payment gate, FHE envelope, logger) is
 *    injected through the constructor — never imported at module scope.
 *  - LSP: public method signatures mirror the upstream MemWal client so
 *    future swaps (operator-pool, FHE, mock) are drop-in.
 *  - OCP: adding new ops = (a) extend POINT_COSTS in types.ts, (b) add a
 *    public method that wraps `runOp(...)`; the kernel is unchanged.
 *
 * G4 isolation: peer-dep `@mysten-incubation/memwal` is loaded ONLY when
 * `MEMWAL_PEERDEP_ENABLED=true`. Otherwise we throw an actionable error so
 * Standard-tier installs never trigger the import.
 */

import { resilientCall } from '@fhe-ai-context/runtime-utils';
import { sha256 } from '@noble/hashes/sha256';

import {
  MEMWAL_NETWORKS,
  POINT_COSTS,
  MEMWAL_RATE_CAPS,
  type AdapterLogger,
  type AnalyzeResult,
  type HealthSnapshot,
  type MemWalNetwork,
  type MemWalOp,
  type MemWalOpName,
  type OpenXMemWalConfig,
  type PaymentGate,
  type RecallResult,
  type RememberResult,
  type RestoreResult,
  type UsageSnapshot,
} from './types';
import {
  OpenXMemWalAccountFrozenError,
  OpenXMemWalCompatibilityError,
  OpenXMemWalError,
  OpenXMemWalInvalidConfigError,
  OpenXMemWalNoAccessError,
  OpenXMemWalPaymentDeniedError,
  OpenXMemWalStorageQuotaError,
  OpenXMemWalUpstreamMissingError,
  MemWalErrorCode,
} from './errors';
import { RateLimitGuard } from './rateLimitGuard';

// ─── Upstream surface (re-typed locally to keep the dep optional) ──────────

interface MemWalLike {
  compatibility(): Promise<{ minSupportedSdk?: string; sdkVersion?: string; relayerVersion?: string } | unknown>;
  health(): Promise<{ status: string; relayerVersion?: string } | unknown>;
  remember?(text: string, namespace?: string): Promise<{ blob_id?: string; job_id?: string }>;
  rememberAndWait?(text: string, namespace?: string): Promise<{ blob_id?: string }>;
  rememberBulkAndWait?(items: Array<{ text: string; namespace?: string }>): Promise<{ job_ids: string[] }>;
  recall(params: { query: string; limit?: number; namespace?: string; maxDistance?: number }): Promise<{
    results: Array<{ blob_id: string; text: string; distance: number; namespace?: string }>;
    total: number;
  }>;
  analyze(text: string, namespace?: string): Promise<{ facts: Array<{ text: string; blob_id?: string }>; total: number }>;
  restore(namespace: string, limit?: number): Promise<{ restored: number; skipped?: number; total: number }>;
  usage?(): Promise<{ storage_bytes?: number; points_used_minute?: number; points_used_hour?: number }>;
}

interface MemWalModuleLike {
  MemWal: { create(cfg: { key: string; accountId: string; serverUrl?: string; namespace?: string }): MemWalLike };
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function isPeerDepEnabled(): boolean {
  return (
    typeof process !== 'undefined' &&
    process.env?.MEMWAL_PEERDEP_ENABLED === 'true'
  );
}

async function loadMemWalModule(): Promise<MemWalModuleLike | null> {
  if (!isPeerDepEnabled()) return null;
  try {
    // ESM-only package — must use dynamic import (`require` would throw
    // ERR_REQUIRE_ESM in CommonJS callers). The SDK itself is CJS so this
    // compiles to a real Promise-returning import.
    //
    // The peer-dep is declared optional in package.json; consumers without
    // it installed should set MEMWAL_PEERDEP_ENABLED=false (above branch).
    // We use @ts-ignore so the build still succeeds whether or not the
    // package is installed at compile time.
    // @ts-ignore optional peer dependency, resolved at runtime
    const mod = (await import('@mysten-incubation/memwal')) as unknown as MemWalModuleLike;
    if (!mod?.MemWal?.create) return null;
    return mod;
  } catch (e) {
    // Surface the underlying reason via console.warn so operators can fix
    // missing peer deps quickly. We still return null so the adapter throws
    // its typed OpenXMemWalUpstreamMissingError to callers.
    if (typeof process !== 'undefined' && process.env?.OPENX_MEMWAL_DEBUG === 'true') {
      // eslint-disable-next-line no-console
      console.warn('[memwal] dynamic import failed:', (e as Error)?.message ?? e);
    }
    return null;
  }
}

function hashHex(s: string): string {
  // `@noble/hashes/sha256` is isomorphic — works in Node and the browser.
  // Using it here (instead of `node:crypto.createHash`) keeps the adapter
  // bundle-safe for the Next.js frontend.
  const digest = sha256(new TextEncoder().encode(s));
  let out = '';
  for (let i = 0; i < 8; i++) out += digest[i].toString(16).padStart(2, '0');
  return out;
}

// Translate well-known upstream error shapes into typed OpenXMemWalErrors.
function translateUpstreamError(e: unknown): OpenXMemWalError {
  const msg = e instanceof Error ? e.message : String(e);
  if (/EAccountDeactivated|deactivated/i.test(msg)) {
    return new OpenXMemWalAccountFrozenError();
  }
  if (/ENoAccess|seal[_ ]approve|denied/i.test(msg)) {
    return new OpenXMemWalNoAccessError();
  }
  return new OpenXMemWalError(
    MemWalErrorCode.Upstream,
    `MemWal upstream error: ${msg}`,
    { cause: e },
  );
}

// ─── Adapter ─────────────────────────────────────────────────────────────

export class OpenXMemWalAdapter {
  private readonly cfg: OpenXMemWalConfig;
  private readonly clients: MemWalLike[];
  private readonly delegateHashes: string[];
  private rrIndex = 0;
  private readonly limiter: RateLimitGuard;
  private readonly logger: AdapterLogger;
  private readonly storageBytesCap: number;

  /** Public version metadata captured at create() time. */
  relayerVersion?: string;
  sdkVersion?: string;

  /** Factory — async because we run a `compatibility()` check on init. */
  static async create(cfg: OpenXMemWalConfig): Promise<OpenXMemWalAdapter> {
    OpenXMemWalAdapter.validateConfig(cfg);
    const mod = await loadMemWalModule();
    if (!mod) throw new OpenXMemWalUpstreamMissingError();

    const network = MEMWAL_NETWORKS[cfg.network];
    if (!network) {
      throw new OpenXMemWalInvalidConfigError(`Unknown MemWal network: ${cfg.network}`);
    }
    const serverUrl = cfg.serverUrl ?? network.relayerUrl;

    const clients = cfg.delegateKeys.map((key) =>
      mod.MemWal.create({ key, accountId: cfg.accountId, serverUrl, namespace: cfg.namespace }),
    );

    const adapter = new OpenXMemWalAdapter(cfg, clients);
    await adapter.bootstrap();
    return adapter;
  }

  private constructor(cfg: OpenXMemWalConfig, clients: MemWalLike[]) {
    this.cfg = cfg;
    this.clients = clients;
    this.delegateHashes = cfg.delegateKeys.map(hashHex);
    this.limiter = new RateLimitGuard(cfg.redis);
    this.logger = cfg.logger ?? noopLogger();
    this.storageBytesCap = cfg.storageBytesCap ?? MEMWAL_RATE_CAPS.storageBytesPerAccount;
  }

  private static validateConfig(cfg: OpenXMemWalConfig): void {
    if (!cfg.walletAddress) {
      throw new OpenXMemWalInvalidConfigError('walletAddress is required');
    }
    if (!cfg.accountId) {
      throw new OpenXMemWalInvalidConfigError('accountId is required');
    }
    if (!cfg.delegateKeys || cfg.delegateKeys.length === 0) {
      throw new OpenXMemWalInvalidConfigError('delegateKeys must include at least one key');
    }
    if (cfg.delegateKeys.length > 20) {
      throw new OpenXMemWalInvalidConfigError(
        `delegateKeys cap is 20 (MemWal hard limit); got ${cfg.delegateKeys.length}`,
      );
    }
  }

  /** Run on init: call upstream compatibility() once and capture versions. */
  private async bootstrap(): Promise<void> {
    const client = this.clients[0];
    try {
      const compat = (await client.compatibility()) as {
        sdkVersion?: string;
        relayerVersion?: string;
        minSupportedSdk?: string;
      };
      this.sdkVersion = compat.sdkVersion;
      this.relayerVersion = compat.relayerVersion;
      if (compat.minSupportedSdk && compat.sdkVersion && compat.minSupportedSdk > compat.sdkVersion) {
        throw new OpenXMemWalCompatibilityError(compat.sdkVersion, compat.minSupportedSdk);
      }
    } catch (e) {
      if (e instanceof OpenXMemWalError) throw e;
      throw translateUpstreamError(e);
    }
  }

  // ─── Public verbs ───────────────────────────────────────────────────

  async health(): Promise<HealthSnapshot> {
    try {
      const r = (await this.clients[0].health()) as { status?: string; relayerVersion?: string };
      return {
        status: r.status === 'ok' ? 'ok' : 'degraded',
        relayerVersion: r.relayerVersion ?? this.relayerVersion,
        sdkVersion: this.sdkVersion,
        network: this.cfg.network,
      };
    } catch (e) {
      throw translateUpstreamError(e);
    }
  }

  async usage(): Promise<UsageSnapshot> {
    const liveSnap = await this.limiter.snapshot(this.cfg.accountId, this.delegateHashes[0]);
    let storageBytes = 0;
    try {
      const us = (await this.clients[0].usage?.()) as { storage_bytes?: number } | undefined;
      storageBytes = us?.storage_bytes ?? 0;
    } catch {
      /* upstream doesn't always expose usage; ignore */
    }
    return {
      pointsUsedMinute: liveSnap.accountMinute,
      pointsUsedHour: liveSnap.accountHour,
      storageBytes,
    };
  }

  async remember(text: string, namespace?: string): Promise<RememberResult> {
    const ns = namespace ?? this.cfg.namespace ?? 'default';
    return this.runOp('remember', { type: 'remember', text, namespace: ns }, async (client) => {
      const out = client.rememberAndWait
        ? await client.rememberAndWait(text, ns)
        : await client.remember!(text, ns);
      return { blob_id: out?.blob_id, job_id: (out as { job_id?: string })?.job_id };
    });
  }

  async recall(
    query: string,
    opts: { limit?: number; namespace?: string; minRelevance?: number } = {},
  ): Promise<RecallResult> {
    const ns = opts.namespace ?? this.cfg.namespace ?? 'default';
    const limit = opts.limit ?? 5;
    return this.runOp('recall', { type: 'recall', query, namespace: ns, limit }, async (client) => {
      const r = await client.recall({
        query,
        limit,
        namespace: ns,
        maxDistance: opts.minRelevance != null ? 1 - opts.minRelevance : undefined,
      });
      return { results: r.results, total: r.total };
    });
  }

  async analyze(text: string, namespace?: string): Promise<AnalyzeResult> {
    const ns = namespace ?? this.cfg.namespace ?? 'default';
    return this.runOp('analyze', { type: 'analyze', text, namespace: ns }, async (client) => {
      const out = await client.analyze(text, ns);
      return { facts: out.facts, total: out.total };
    });
  }

  async restore(namespace: string, limit?: number): Promise<RestoreResult> {
    return this.runOp(
      'restore',
      { type: 'restore', namespace, limit: limit ?? 100 },
      async (client) => {
        const out = await client.restore(namespace, limit);
        return { restored: out.restored, skipped: out.skipped ?? 0, total: out.total };
      },
    );
  }

  async rememberBulk(items: Array<{ text: string; namespace?: string }>): Promise<{ job_ids: string[] }> {
    if (items.length === 0) return { job_ids: [] };
    if (items.length > 20) {
      throw new OpenXMemWalInvalidConfigError(
        `rememberBulk: ≤20 items per call (MemWal limit); got ${items.length}`,
      );
    }
    // Distribute across the pool when len(pool) > 1 (operator-pool fanout).
    const groups = this.shardForBulk(items);
    const jobs: string[] = [];
    for (let i = 0; i < groups.length; i++) {
      const client = this.clients[i % this.clients.length];
      const delHash = this.delegateHashes[i % this.delegateHashes.length];
      const points = POINT_COSTS.rememberBulk;
      await this.checkPaymentAndCharge('rememberBulk', delHash, points);
      try {
        const out = await resilientCall(
          { name: 'memwal.rememberBulk', maxAttempts: 3 },
          () => client.rememberBulkAndWait!(groups[i]),
        );
        jobs.push(...out.job_ids);
      } catch (e) {
        throw e instanceof OpenXMemWalError ? e : translateUpstreamError(e);
      }
    }
    return { job_ids: jobs };
  }

  /** No real resource to release for now; reserved for future SSE/keepalive. */
  async destroy(): Promise<void> {
    /* no-op */
  }

  // ─── Internal kernel — every public op flows through here ─────────────

  private async runOp<T>(
    op: MemWalOpName,
    envelope: MemWalOp,
    body: (client: MemWalLike) => Promise<T>,
  ): Promise<T & { tx_hash?: string }> {
    const client = this.pickClient();
    const delHash = this.pickDelegateHash();
    const points = POINT_COSTS[op];

    // 1. Payment gate (if configured) — fail closed before any work.
    const tx_hash = await this.runPaymentGate(envelope);

    // 2. Storage quota — block writes when account is at cap.
    if (op === 'remember' || op === 'analyze' || op === 'rememberBulk') {
      await this.assertStorageHeadroom();
    }

    // 3. Rate limit — three-window guard mirroring MemWal caps.
    await this.limiter.charge(this.cfg.accountId, delHash, points);

    // 4. Upstream call wrapped in resilientCall (3 attempts with backoff).
    const start = Date.now();
    try {
      const result = await resilientCall<T>({ name: `memwal.${op}`, maxAttempts: 3 }, () => body(client));
      this.logger.info(
        {
          op,
          account_id: hashHex(this.cfg.accountId),
          namespace_hash: 'namespace' in envelope ? hashHex(envelope.namespace) : undefined,
          ms: Date.now() - start,
          points_charged: points,
          tx_hash: tx_hash ?? null,
        },
        'memwal.op',
      );
      return Object.assign({}, result, { tx_hash }) as T & { tx_hash?: string };
    } catch (e) {
      if (e instanceof OpenXMemWalError) throw e;
      throw translateUpstreamError(e);
    }
  }

  private async runPaymentGate(
    envelope: MemWalOp,
  ): Promise<string | undefined> {
    const gate: PaymentGate | undefined = this.cfg.paymentGate;
    if (!gate) return undefined;
    const decision = await gate(envelope);
    if (!decision.allowed) {
      throw new OpenXMemWalPaymentDeniedError(decision.reason);
    }
    return decision.tx_hash;
  }

  private async assertStorageHeadroom(): Promise<void> {
    let used = 0;
    try {
      const u = (await this.clients[0].usage?.()) as { storage_bytes?: number } | undefined;
      used = u?.storage_bytes ?? 0;
    } catch {
      return; // upstream not exposing usage — skip the guard rather than blocking ops.
    }
    if (used >= this.storageBytesCap * 0.95) {
      throw new OpenXMemWalStorageQuotaError(used, this.storageBytesCap);
    }
    if (used >= this.storageBytesCap * 0.8) {
      this.logger.warn(
        { account_id: hashHex(this.cfg.accountId), used, cap: this.storageBytesCap },
        'memwal.storage.pressure',
      );
    }
  }

  private async checkPaymentAndCharge(op: MemWalOpName, delHash: string, points: number): Promise<void> {
    await this.limiter.charge(this.cfg.accountId, delHash, points);
    void op; // reserved for future per-op metrics
  }

  // ─── Pool round-robin (private, inlined — single concern, ~20 lines) ──

  private pickClient(): MemWalLike {
    const i = this.rrIndex % this.clients.length;
    this.rrIndex = (this.rrIndex + 1) % this.clients.length;
    return this.clients[i];
  }

  private pickDelegateHash(): string {
    const i = this.rrIndex % this.delegateHashes.length;
    return this.delegateHashes[i];
  }

  private shardForBulk<T>(items: T[]): T[][] {
    const n = Math.max(1, this.clients.length);
    const groups: T[][] = Array.from({ length: n }, () => []);
    items.forEach((it, i) => groups[i % n].push(it));
    return groups.filter((g) => g.length > 0);
  }

  // Convenience for tests / consumers that need a typed peek at IDs.
  get networkConfig() {
    return MEMWAL_NETWORKS[this.cfg.network];
  }
}

// ─── retry policy is delegated to runtime-utils' resilientCall ───────────

// (resilientCall already implements exp-backoff + circuit breaker; we surface
//  upstream errors via translateUpstreamError after the final attempt.)

// ─── default no-op logger ────────────────────────────────────────────────

function noopLogger(): AdapterLogger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

// Re-export the error code enum for convenience (single source = errors.ts).
export { MemWalErrorCode } from './errors';
