/**
 * memwal/index.ts — public barrel for the OpenX MemWal adapter.
 *
 * Single import surface for every consumer (api/, frontend/, scripts/).
 * Internal modules (rateLimitGuard, peer-dep loader) are intentionally NOT
 * re-exported — they are implementation details.
 */

export { OpenXMemWalAdapter } from './adapter';
export {
  MEMWAL_NETWORKS,
  MEMWAL_RATE_CAPS,
  POINT_COSTS,
  type AdapterLogger,
  type AnalyzeResult,
  type HealthSnapshot,
  type MemWalNetwork,
  type MemWalNetworkConfig,
  type MemWalOp,
  type MemWalOpName,
  type OpenXMemWalConfig,
  type PaymentGate,
  type PaymentGateResult,
  type RateLimitRedisLike,
  type RecallHit,
  type RecallResult,
  type RememberResult,
  type RestoreResult,
  type UsageSnapshot,
} from './types';
export {
  MemWalErrorCode,
  type MemWalErrorCodeT,
  OpenXMemWalAccountFrozenError,
  OpenXMemWalCompatibilityError,
  OpenXMemWalError,
  OpenXMemWalInvalidConfigError,
  OpenXMemWalNoAccessError,
  OpenXMemWalPaymentDeniedError,
  OpenXMemWalRateLimitError,
  OpenXMemWalStorageQuotaError,
  OpenXMemWalUpstreamMissingError,
} from './errors';
