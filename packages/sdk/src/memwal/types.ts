/**
 * memwal/types.ts — public types for `@openx/memwal-adapter`.
 *
 * Kept in a single file (SRP for type surface) so consumers in api/, frontend/,
 * worker/, and scripts/ all import from one stable place.
 */

export type MemWalNetwork = 'mainnet' | 'testnet' | 'local';

/** Per-network MemWal contract IDs + relayer URL. */
export interface MemWalNetworkConfig {
  packageId: string;
  registryId: string;
  relayerUrl: string;
}

/**
 * Verified upstream IDs from docs.wal.app (testnet-v1.50.0, June 3 2026).
 * Local can be overridden at adapter init via env.
 */
export const MEMWAL_NETWORKS: Record<MemWalNetwork, MemWalNetworkConfig> = {
  mainnet: {
    packageId:
      '0xcee7a6fd8de52ce645c38332bde23d4a30fd9426bc4681409733dd50958a24c6',
    registryId:
      '0x0da982cefa26864ae834a8a0504b904233d49e20fcc17c373c8bed99c75a7edd',
    relayerUrl: 'https://relayer.memory.walrus.xyz',
  },
  testnet: {
    packageId:
      '0xcf6ad755a1cdff7217865c796778fabe5aa399cb0cf2eba986f4b582047229c6',
    registryId:
      '0xe80f2feec1c139616a86c9f71210152e2a7ca552b20841f2e192f99f75864437',
    relayerUrl: 'https://relayer-staging.memory.walrus.xyz',
  },
  local: {
    packageId: '',
    registryId: '',
    relayerUrl: 'http://127.0.0.1:8000',
  },
};

/** Operation envelope passed to a paymentGate callback. */
export type MemWalOp =
  | { type: 'remember'; text: string; namespace: string }
  | { type: 'recall'; query: string; namespace: string; limit: number }
  | { type: 'analyze'; text: string; namespace: string }
  | { type: 'restore'; namespace: string; limit: number };

export type PaymentGateResult =
  | { allowed: true; tx_hash?: string }
  | { allowed: false; reason: string };

export type PaymentGate = (op: MemWalOp) => Promise<PaymentGateResult>;

/** Per-tool point cost (mirrors upstream MemWal relayer's cost-weighted limits). */
export const POINT_COSTS = {
  remember: 5,
  recall: 1,
  analyze: 10,
  restore: 3,
  rememberBulk: 5, // charged per call, not per item
} as const;

export type MemWalOpName = keyof typeof POINT_COSTS;

/** MemWal-enforced caps. Mirror these in the local rate-limit guard. */
export const MEMWAL_RATE_CAPS = {
  perAccountMinute: 60,
  perAccountHour: 500,
  perDelegateMinute: 30,
  storageBytesPerAccount: 1_000_000_000, // 1 GB
} as const;

export interface OpenXMemWalConfig {
  /** Sui network — picks PACKAGE_ID + relayerUrl from MEMWAL_NETWORKS. */
  network: MemWalNetwork;
  /** Buyer or seller wallet address (canonical Sui address for MemWal). */
  walletAddress: string;
  /** Sui MemWalAccount object id. Resolve via agentLinkOracle on the server. */
  accountId: string;
  /** Pool of Ed25519 hex keys (1..20). Adapter round-robins through them. */
  delegateKeys: string[];
  /** Default namespace; per-call still wins (matches upstream semantics). */
  namespace?: string;
  /** Override the relayer URL (e.g. a self-hosted OpenX-operated relayer). */
  serverUrl?: string;
  /** Optional payment gate — invoked before every paid op. */
  paymentGate?: PaymentGate;
  /** Optional Redis client for the rate-limit guard. Falls back to in-memory. */
  redis?: RateLimitRedisLike;
  /** Optional structured logger. Defaults to no-op. */
  logger?: AdapterLogger;
  /** Override storage cap awareness (default = MEMWAL_RATE_CAPS.storageBytesPerAccount). */
  storageBytesCap?: number;
}

/** Minimal Redis surface the rate-limit guard depends on (DIP). */
export interface RateLimitRedisLike {
  zadd(key: string, score: number, member: string): Promise<number>;
  zremrangebyscore(key: string, min: number, max: number): Promise<number>;
  zcard(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

export interface AdapterLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export interface RecallHit {
  blob_id: string;
  text: string;
  distance: number;
  namespace?: string;
}

export interface RecallResult {
  results: RecallHit[];
  total: number;
  /** From paymentGate, for billing reconciliation. */
  tx_hash?: string;
}

export interface RememberResult {
  blob_id?: string;
  job_id?: string;
  tx_hash?: string;
}

export interface AnalyzeResult {
  facts: Array<{ text: string; blob_id?: string }>;
  total: number;
}

export interface RestoreResult {
  restored: number;
  skipped: number;
  total: number;
}

export interface UsageSnapshot {
  pointsUsedMinute: number;
  pointsUsedHour: number;
  storageBytes: number;
}

export interface HealthSnapshot {
  status: 'ok' | 'degraded';
  relayerVersion?: string;
  sdkVersion?: string;
  network: MemWalNetwork;
}
