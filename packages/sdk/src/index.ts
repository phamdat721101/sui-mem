/**
 * @openx/sdk — Sui-native OpenX SDK.
 *
 * Public surface (Sui-only after the EVM/Fhenix pivot):
 *   - MemWal adapter — the single supported way OpenX talks to Walrus Memory
 *   - Cognitive namespaces — `cog-l{N}-{brainId}` formatter
 *   - PayRouter — sui_usdc + x402 + mpp rails (no fherc20)
 *   - MCP server — JSON-RPC 2.0 dispatch with the openx_* + memwal_* tools
 *   - Brain types — chain-agnostic shapes (chain literal is now Sui-only)
 */

// MemWal — the heart of the Sui memory market.
export {
  OpenXMemWalAdapter,
  MEMWAL_NETWORKS,
  MEMWAL_RATE_CAPS,
  POINT_COSTS,
  MemWalErrorCode,
  OpenXMemWalAccountFrozenError,
  OpenXMemWalCompatibilityError,
  OpenXMemWalError,
  OpenXMemWalInvalidConfigError,
  OpenXMemWalNoAccessError,
  OpenXMemWalPaymentDeniedError,
  OpenXMemWalRateLimitError,
  OpenXMemWalStorageQuotaError,
  OpenXMemWalUpstreamMissingError,
  type AdapterLogger as MemWalAdapterLogger,
  type AnalyzeResult as MemWalAnalyzeResult,
  type HealthSnapshot as MemWalHealthSnapshot,
  type MemWalNetwork,
  type MemWalNetworkConfig,
  type MemWalOp,
  type MemWalOpName,
  type OpenXMemWalConfig,
  type PaymentGate as MemWalPaymentGate,
  type PaymentGateResult as MemWalPaymentGateResult,
  type RateLimitRedisLike,
  type RecallHit as MemWalRecallHit,
  type RecallResult as MemWalRecallResult,
  type RememberResult as MemWalRememberResult,
  type RestoreResult as MemWalRestoreResult,
  type UsageSnapshot as MemWalUsageSnapshot,
} from './memwal';

// Cognitive ↔ MemWal namespace formatter.
export * from './cognitive/namespaces';

// Brain types — single source of truth for Sui chain identifiers.
export * from './brain/types';

// Payment router — sui_usdc + x402 + mpp.
export * from './payment/payRouter';

// MCP server + tool registry.
export * from './mcp/server';
export * from './mcp/tools';
