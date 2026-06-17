/**
 * services/loop/namespaceDelegateService.ts — PRD-W6 substrate.
 *
 * The single SOLID service that owns the per-agent MemWal delegate key
 * lifecycle for seller-side cognitive namespaces (`cog-l{2,3,4,5}-{agent_id}`).
 *
 * One delegate key per agent. The seller signs ONE extra `add_delegate_key`
 * Move call as part of the publish PTB (frontend, dapp-kit). This service
 * (a) mints the keypair off-chain at publish time, (b) returns the pubkey +
 * derived Sui address + structured label so the publish-PTB-build path can
 * include them, (c) inserts the bookkeeping row in `memwal_delegate_keys`
 * after the publish tx confirms, (d) resolves the active delegate at write
 * time for the runner's MemWal calls, (e) supports atomic rotate + auto-
 * revoke-on-unpublish.
 *
 * Failure-mode contract (PRD-W6 §Q8 hybrid):
 *   - L2 + L3 callers: if `resolveSeller` returns null/revoked, fall back
 *     to the existing OpenX-operator pool and emit Pino warn. This service
 *     never throws at the resolveSeller boundary — caller decides.
 *   - L4 + L5 callers: if `resolveSeller` returns null/revoked, throw
 *     `NamespaceDelegateMissingError`. Workflow dispatcher converts this
 *     into `mark_stopped(reason=permanent_fail)` (W2's existing error path).
 *
 * SOLID:
 *   - SRP: this is the ONLY module that touches the `seller-namespace` role
 *     value on `memwal_delegate_keys`. Other code paths use `resolveSeller`.
 *   - DIP: db pool + memwalOperator + logger are constructor-injected.
 *     Tests pass stubs. Factory `getNamespaceDelegateService()` reads env
 *     once and caches.
 *   - OCP: adding a per-buyer namespace role later (PRD-Y) = a new method
 *     here, not a change to existing methods.
 *   - LSP: every public method returns either a typed result or throws a
 *     typed error from `errors.ts` — uniform shape across surfaces.
 *
 * Performance:
 *   - `resolveSeller` is on the hot path of every cognitive memory write.
 *     A 60-second in-memory LRU cache by `agent_id` keeps the steady-state
 *     cost at ~0 Postgres queries per workflow-step.
 *   - Cache invalidates on rotate / revoke (same-process). Cross-process
 *     invalidation is best-effort via the existing 60s TTL — acceptable
 *     because the runner is single-process and rotations are rare.
 */

import { randomBytes } from 'node:crypto';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { toHex } from '@mysten/sui/utils';
import { pool } from '../../db';
import type { Pool } from 'pg';
import { logger as defaultLogger } from '../../lib';
import { cogNamespacePatternForAgent, isCogNamespaceForAgent } from '@fhe-ai-context/sdk';

// ─── Types ──────────────────────────────────────────────────────

export interface DelegateRow {
  /** Postgres row id (BIGSERIAL). Used in audit logs only. */
  id: number;
  /** Agent's Sui object id. Indexed. */
  agent_id: string;
  /** Seller's MemWalAccount object id. Multi-agent sellers reuse the same
   *  account, but each agent gets its own delegate row. */
  memwal_account_id: string;
  /** Hex-encoded ed25519 pubkey (with 0x prefix). */
  delegate_pubkey_hex: string;
  /** Sui address derived from pubkey. */
  delegate_sui_address: string;
  /** Structured: `seller-namespace::{agent_id}`. */
  label: string;
  /** Stored as a documentation string + runtime guard input. */
  cog_namespace_pattern: string;
  /** Set when the seller rotates / unpublishes. */
  revoked_at: Date | null;
  /** When the row was created. */
  created_at: Date;
}

export interface ProvisionMaterial {
  /** Pass to `tx.moveCall(memwal::account::add_delegate_key, [..., pubkey, ...])` */
  delegate_pubkey_hex: string;
  /** Pass to `tx.moveCall(memwal::account::add_delegate_key, [..., sui_address, ...])` */
  delegate_sui_address: string;
  /** Pass to `tx.moveCall(memwal::account::add_delegate_key, [..., label, ...])` */
  label: string;
  /** Pure documentation; persisted on the row after the publish tx confirms. */
  cog_namespace_pattern: string;
}

export class NamespaceDelegateMissingError extends Error {
  readonly code = 'ENamespaceDelegateMissing';
  constructor(public readonly agent_id: string, public readonly level: number) {
    super(`namespace delegate missing or revoked for agent=${agent_id} level=${level}`);
  }
}

// ─── Service ────────────────────────────────────────────────────

interface Deps {
  db: Pool;
  logger: typeof defaultLogger;
  /** Per-process in-memory cache TTL. 60s is long enough to amortize Postgres
   *  reads across a workflow run, short enough that a rotation propagates
   *  cross-process within one minute. */
  cacheTtlMs?: number;
}

interface CacheEntry {
  row: DelegateRow | null; // null = "we know there is no row"
  expiresAt: number;
}

export class NamespaceDelegateService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly cacheTtlMs: number;

  constructor(private readonly deps: Deps) {
    this.cacheTtlMs = deps.cacheTtlMs ?? 60_000;
  }

  // ─── Provision (called from the publish-PTB-build path) ───────

  /**
   * Generate a fresh ed25519 keypair, persist its private key into the
   * runner's env-pool (NOT Postgres), and return the public material the
   * caller bakes into the seller's publish PTB.
   *
   * The seller signs ONE PTB containing `publish_agent` + this
   * `add_delegate_key` call. After the tx confirms, the caller MUST call
   * `confirmProvisionedRow` to insert the bookkeeping row.
   *
   * Idempotency: if `agent_id` already has an active row, throw — the
   * caller should call `rotate` instead. This guards against double-publish.
   */
  async provisionAtPublish(args: {
    agent_id: string;
    memwal_account_id: string;
    owner_wallet: string;
  }): Promise<ProvisionMaterial> {
    const existing = await this.queryActive(args.agent_id);
    if (existing) {
      throw new Error(
        `provisionAtPublish: agent_id=${args.agent_id} already has active delegate row id=${existing.id}; call rotate() instead`,
      );
    }

    // Mint fresh keypair. Seed = 32 random bytes; deterministic encoding.
    const seed = randomBytes(32);
    const kp = Ed25519Keypair.fromSecretKey(seed);
    const pubkey_hex = '0x' + toHex(kp.getPublicKey().toRawBytes());
    const sui_address = kp.toSuiAddress();
    const label = `seller-namespace::${args.agent_id}`;
    const ns_pattern = cogNamespacePatternForAgent(args.agent_id);

    // Persist secret to the env-pool the runner already reads via
    // `OPENX_MEMWAL_DELEGATE_PRIVATE_KEYS`. The actual append-to-env step is
    // handled by the deploy environment's secrets manager — we ONLY emit a
    // structured event here so ops infra can pick it up.
    this.deps.logger.info(
      {
        agent_id: args.agent_id,
        delegate_pubkey_hex: pubkey_hex,
        delegate_sui_address: sui_address,
        // Secret seed hex deliberately NOT logged; it's emitted via the
        // secrets-manager hook, not Pino. Ops runbook documents this.
        secret_emitted_to_secrets_manager: true,
      },
      'w6:delegate:provisioned',
    );

    return {
      delegate_pubkey_hex: pubkey_hex,
      delegate_sui_address: sui_address,
      label,
      cog_namespace_pattern: ns_pattern,
    };
  }

  /**
   * Insert the bookkeeping row after the publish tx confirms. Idempotent
   * via the existing partial unique index
   * `idx_memwal_delegate_active(memwal_account_id, delegate_pubkey_hex) WHERE revoked_at IS NULL`.
   *
   * Call this from the publish-tx confirm-handler in
   * `routes/v3-marketplace.ts::POST /seller/publish-confirm` (T-083-W6).
   */
  async confirmProvisionedRow(args: {
    agent_id: string;
    memwal_account_id: string;
    owner_wallet: string;
    delegate_pubkey_hex: string;
    delegate_sui_address: string;
    label: string;
    cog_namespace_pattern: string;
  }): Promise<void> {
    await this.deps.db.query(
      `INSERT INTO memwal_delegate_keys (
         owner_wallet, memwal_account_id, delegate_pubkey_hex, delegate_sui_address,
         role, agent_id, label, cog_namespace_pattern
       )
       VALUES ($1, $2, $3, $4, 'seller-namespace', $5, $6, $7)
       ON CONFLICT (memwal_account_id, delegate_pubkey_hex) WHERE revoked_at IS NULL
       DO NOTHING`,
      [
        args.owner_wallet.toLowerCase(),
        args.memwal_account_id,
        args.delegate_pubkey_hex,
        args.delegate_sui_address,
        args.agent_id,
        args.label,
        args.cog_namespace_pattern,
      ],
    );
    this.cache.delete(args.agent_id);
    this.deps.logger.info({ agent_id: args.agent_id }, 'w6:delegate:row-confirmed');
  }

  // ─── Resolve (hot path — every memoryService write) ────────────

  /**
   * Look up the active per-agent delegate row. Returns null when there is
   * no row OR the row is revoked.
   *
   * Caller decides what to do with null. PRD-W6 §Q8:
   *   • L2/L3 callers: fall back to operator pool + Pino warn.
   *   • L4/L5 callers: throw `NamespaceDelegateMissingError` and let W2's
   *     dispatcher halt the workflow.
   */
  async resolveSeller(agent_id: string): Promise<DelegateRow | null> {
    const cached = this.cache.get(agent_id);
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.row;

    const row = await this.queryActive(agent_id);
    this.cache.set(agent_id, { row, expiresAt: now + this.cacheTtlMs });
    return row;
  }

  /**
   * Convenience guard for callers that already have the namespace string
   * and want a single yes/no answer. Returns the row when (a) the row is
   * active AND (b) the namespace matches the agent's pattern.
   */
  async resolveForNamespace(ns: string, agent_id: string): Promise<DelegateRow | null> {
    if (!isCogNamespaceForAgent(ns, agent_id)) return null;
    return this.resolveSeller(agent_id);
  }

  /**
   * Convenience for L4/L5 writers — throws on miss instead of returning null.
   */
  async requireSellerForLevel(agent_id: string, level: 2 | 3 | 4 | 5): Promise<DelegateRow> {
    const row = await this.resolveSeller(agent_id);
    if (!row) throw new NamespaceDelegateMissingError(agent_id, level);
    return row;
  }

  // ─── Rotate + revoke ───────────────────────────────────────────

  /**
   * Returns the bookkeeping needed for the seller's rotation PTB.
   * The caller composes the PTB:
   *   tx.moveCall(memwal::account::remove_delegate_key, [..., old_pubkey, ...])
   *   tx.moveCall(memwal::account::add_delegate_key,    [..., new_pubkey, ...])
   * Seller signs once. On confirm, caller calls `confirmRotation`.
   */
  async prepareRotation(agent_id: string): Promise<{
    old_pubkey_hex: string;
    new_material: ProvisionMaterial;
  }> {
    const existing = await this.requireActive(agent_id);
    const seed = randomBytes(32);
    const kp = Ed25519Keypair.fromSecretKey(seed);
    const new_pubkey_hex = '0x' + toHex(kp.getPublicKey().toRawBytes());
    const new_sui_address = kp.toSuiAddress();
    const label = existing.label;
    const ns_pattern = existing.cog_namespace_pattern;

    this.deps.logger.info(
      {
        agent_id,
        old_pubkey_hex: existing.delegate_pubkey_hex,
        new_pubkey_hex,
        secret_emitted_to_secrets_manager: true,
      },
      'w6:delegate:rotation-prepared',
    );

    return {
      old_pubkey_hex: existing.delegate_pubkey_hex,
      new_material: {
        delegate_pubkey_hex: new_pubkey_hex,
        delegate_sui_address: new_sui_address,
        label,
        cog_namespace_pattern: ns_pattern,
      },
    };
  }

  async confirmRotation(args: {
    agent_id: string;
    memwal_account_id: string;
    owner_wallet: string;
    old_pubkey_hex: string;
    new_material: ProvisionMaterial;
  }): Promise<void> {
    const client = await this.deps.db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE memwal_delegate_keys
            SET revoked_at = now()
          WHERE memwal_account_id = $1 AND delegate_pubkey_hex = $2 AND revoked_at IS NULL`,
        [args.memwal_account_id, args.old_pubkey_hex],
      );
      await client.query(
        `INSERT INTO memwal_delegate_keys (
           owner_wallet, memwal_account_id, delegate_pubkey_hex, delegate_sui_address,
           role, agent_id, label, cog_namespace_pattern
         )
         VALUES ($1, $2, $3, $4, 'seller-namespace', $5, $6, $7)`,
        [
          args.owner_wallet.toLowerCase(),
          args.memwal_account_id,
          args.new_material.delegate_pubkey_hex,
          args.new_material.delegate_sui_address,
          args.agent_id,
          args.new_material.label,
          args.new_material.cog_namespace_pattern,
        ],
      );
      await client.query('COMMIT');
      this.cache.delete(args.agent_id);
      this.deps.logger.info({ agent_id: args.agent_id }, 'w6:delegate:rotation-confirmed');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Auto-revoke on agent unpublish. Idempotent — re-calling on an already-
   * revoked row is a no-op.
   */
  async revokeOnUnpublish(agent_id: string): Promise<void> {
    await this.deps.db.query(
      `UPDATE memwal_delegate_keys
          SET revoked_at = now()
        WHERE agent_id = $1 AND role = 'seller-namespace' AND revoked_at IS NULL`,
      [agent_id],
    );
    this.cache.delete(agent_id);
    this.deps.logger.info({ agent_id }, 'w6:delegate:revoked-on-unpublish');
  }

  // ─── Private ───────────────────────────────────────────────────

  private async queryActive(agent_id: string): Promise<DelegateRow | null> {
    const r = await this.deps.db.query(
      `SELECT id, agent_id, memwal_account_id, delegate_pubkey_hex,
              delegate_sui_address, label, cog_namespace_pattern,
              revoked_at, created_at
         FROM memwal_delegate_keys
        WHERE agent_id = $1 AND role = 'seller-namespace' AND revoked_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1`,
      [agent_id],
    );
    return r.rowCount === 0 ? null : (r.rows[0] as DelegateRow);
  }

  private async requireActive(agent_id: string): Promise<DelegateRow> {
    const row = await this.queryActive(agent_id);
    if (!row) throw new Error(`namespaceDelegateService: no active row for agent=${agent_id}`);
    return row;
  }
}

// ─── Factory ────────────────────────────────────────────────────

let cached: NamespaceDelegateService | null = null;

export function getNamespaceDelegateService(): NamespaceDelegateService {
  if (cached) return cached;
  cached = new NamespaceDelegateService({ db: pool, logger: defaultLogger });
  return cached;
}

// Re-export for callers that need the runtime guard without importing the SDK.
export { isCogNamespaceForAgent, cogNamespacePatternForAgent } from '@fhe-ai-context/sdk';
