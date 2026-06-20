/**
 * services/memwalMirror.ts — PRD-X1 OpenXMemWalMirror.
 *
 * Replaces the placeholder `{ remember: async () => null }` mirrors at the 3
 * stub sites (server.ts, routes/v3-loop.ts, services/loop/agentInvoker.ts)
 * with a real `OpenXMemWalAdapter`-backed mirror so that every L2-L5
 * cognitive write reaches the canonical decentralized record (Walrus blob
 * id stored on the `cognitive_memories` row).
 *
 * Gated by `FEATURE_LOOP_MIRROR_LIVE`. When the flag is off — or required
 * env is incomplete — `getOpenXMemWalMirror()` returns a singleton no-op
 * (legacy behavior is byte-identical).
 *
 * Failure-mode contract per Master PRD §5.1:
 *   - `OPENX_MIRROR_FAIL_OPEN=true` (Sprint 0 default, 7-day soak): mirror
 *     returns null on adapter error → `MemoryService.softWrite` continues,
 *     `hardWrite` (L4/L5) throws via the existing catch chain.
 *   - `OPENX_MIRROR_FAIL_OPEN=false` (Day-37 onward): mirror throws → both
 *     soft + hard writes propagate; dispatcher converts L4/L5 failures to
 *     `mark_stopped(permanent_fail)` per PRD-W6 hybrid contract.
 *
 * SOLID:
 *   - SRP: one verb (`remember`). No PTB, no ledger, no Walrus upload.
 *   - DIP: `OpenXMemWalAdapter` is constructor-injected via the factory;
 *     tests can pass any `MemWalMirror`-shaped stub directly to the 3
 *     sites without touching this file.
 *   - OCP: per-agent W6 delegate-key routing is X8 work; that layer
 *     replaces the singleton with a per-agent resolver without any change
 *     to the call-sites that consume `MemWalMirror`.
 *
 * Performance:
 *   - Adapter init is lazy (first `remember()` pays the cost). Module
 *     load stays cheap when the flag is off.
 *   - Adapter is reused across calls; no per-call SDK construction.
 */

import {
  OpenXMemWalAdapter,
  type MemWalNetwork,
} from '@fhe-ai-context/sdk';
import type { MemWalMirror } from './loop/memoryService';
import { logger as rootLogger } from '../lib';

interface MirrorConfig {
  failOpen: boolean;
  network: MemWalNetwork;
  walletAddress: string;
  accountId: string;
  delegateKeys: string[];
  serverUrl?: string;
}

export class OpenXMemWalMirror implements MemWalMirror {
  private adapter: OpenXMemWalAdapter | null = null;
  private adapterPromise: Promise<OpenXMemWalAdapter> | null = null;

  constructor(private readonly cfg: MirrorConfig) {}

  async remember(args: {
    namespace: string;
    text: string;
    agent_id?: string;
  }): Promise<string | null> {
    try {
      const adapter = await this.getOrInit();
      const out = await adapter.remember(args.text, args.namespace);
      const blob = out.blob_id ?? null;
      rootLogger.info(
        { ns: args.namespace, walrus_blob_id: blob, agent_id: args.agent_id ?? null },
        'mirror:write',
      );
      return blob;
    } catch (e) {
      const err = e as Error;
      if (this.cfg.failOpen) {
        rootLogger.warn(
          { ns: args.namespace, err: err.message, agent_id: args.agent_id ?? null },
          'mirror:write_failed_continue',
        );
        return null;
      }
      throw err;
    }
  }

  /** Lazy adapter init — first call pays the upstream MemWal SDK import cost. */
  private async getOrInit(): Promise<OpenXMemWalAdapter> {
    if (this.adapter) return this.adapter;
    if (this.adapterPromise) return this.adapterPromise;
    this.adapterPromise = OpenXMemWalAdapter.create({
      network: this.cfg.network,
      walletAddress: this.cfg.walletAddress,
      accountId: this.cfg.accountId,
      delegateKeys: this.cfg.delegateKeys,
      serverUrl: this.cfg.serverUrl,
      logger: {
        info: (o, m) => rootLogger.info(o, m ?? 'memwal'),
        warn: (o, m) => rootLogger.warn(o, m ?? 'memwal'),
        error: (o, m) => rootLogger.error(o, m ?? 'memwal'),
      },
    });
    this.adapter = await this.adapterPromise;
    this.adapterPromise = null;
    return this.adapter;
  }
}

const NOOP: MemWalMirror = { remember: async () => null };

let _instance: MemWalMirror | null = null;

/**
 * Single instantiation point used by every stub site. Returns the live
 * mirror when `FEATURE_LOOP_MIRROR_LIVE=true` AND the operator-pool env
 * is present; otherwise returns the no-op (byte-identical to legacy).
 */
export function getOpenXMemWalMirror(): MemWalMirror {
  if (_instance) return _instance;
  if (process.env.FEATURE_LOOP_MIRROR_LIVE !== 'true') {
    return (_instance = NOOP);
  }
  const accountId = process.env.OPENX_OPERATOR_MEMWAL_ACCOUNT_ID;
  const walletAddress = process.env.OPENX_OPERATOR_WALLET_ADDRESS;
  const delegateKeys = (process.env.OPENX_MEMWAL_DELEGATE_PRIVATE_KEYS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!accountId || !walletAddress || delegateKeys.length === 0) {
    rootLogger.warn(
      {
        has_account: !!accountId,
        has_wallet: !!walletAddress,
        delegate_key_count: delegateKeys.length,
      },
      'mirror:env_incomplete_using_noop',
    );
    return (_instance = NOOP);
  }
  const network = (process.env.MEMWAL_NETWORK as MemWalNetwork) ?? 'testnet';
  const failOpen = process.env.OPENX_MIRROR_FAIL_OPEN !== 'false';
  return (_instance = new OpenXMemWalMirror({
    failOpen,
    network,
    walletAddress,
    accountId,
    delegateKeys,
    serverUrl: process.env.MEMWAL_RELAYER_URL || undefined,
  }));
}

/** Test-only: reset the singleton between unit tests. */
export function _resetOpenXMemWalMirror(): void {
  _instance = null;
}
