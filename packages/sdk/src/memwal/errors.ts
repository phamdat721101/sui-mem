/**
 * memwal/errors.ts — typed errors thrown by `OpenXMemWalAdapter`.
 *
 * Every error carries a `code` constant that maps cleanly to:
 *  - HTTP status codes in /v3/memory/* routes
 *  - JSON-RPC error codes in @openx/mcp-gateway (PRD-09 §9)
 *
 * Single source of truth — no error-string matching in callers.
 */

export const MemWalErrorCode = {
  UpstreamMissing: 'OPENX_MEMWAL_UPSTREAM_MISSING',
  Compatibility: 'OPENX_MEMWAL_COMPATIBILITY_MISMATCH',
  PaymentDenied: 'OPENX_MEMWAL_PAYMENT_DENIED',
  RateLimit: 'OPENX_MEMWAL_RATE_LIMIT',
  AccountFrozen: 'OPENX_MEMWAL_ACCOUNT_FROZEN',
  NoAccess: 'OPENX_MEMWAL_NO_ACCESS',
  StorageQuota: 'OPENX_MEMWAL_STORAGE_QUOTA',
  InvalidConfig: 'OPENX_MEMWAL_INVALID_CONFIG',
  Upstream: 'OPENX_MEMWAL_UPSTREAM_ERROR',
} as const;

export type MemWalErrorCodeT = (typeof MemWalErrorCode)[keyof typeof MemWalErrorCode];

export class OpenXMemWalError extends Error {
  readonly code: MemWalErrorCodeT;
  readonly retryAfterMs?: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: MemWalErrorCodeT,
    message: string,
    extras: { retryAfterMs?: number; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'OpenXMemWalError';
    this.code = code;
    this.retryAfterMs = extras.retryAfterMs;
    this.details = extras.details;
    if (extras.cause !== undefined) {
      // Preserve original error chain when wrapping upstream throws.
      (this as Error & { cause?: unknown }).cause = extras.cause;
    }
  }
}

export class OpenXMemWalUpstreamMissingError extends OpenXMemWalError {
  constructor() {
    super(
      MemWalErrorCode.UpstreamMissing,
      '@mysten-incubation/memwal is not installed or MEMWAL_PEERDEP_ENABLED is false. ' +
        'Install with: npm install @mysten-incubation/memwal && set MEMWAL_PEERDEP_ENABLED=true.',
    );
    this.name = 'OpenXMemWalUpstreamMissingError';
  }
}

export class OpenXMemWalPaymentDeniedError extends OpenXMemWalError {
  constructor(reason: string) {
    super(MemWalErrorCode.PaymentDenied, `Payment denied: ${reason}`);
    this.name = 'OpenXMemWalPaymentDeniedError';
  }
}

export class OpenXMemWalRateLimitError extends OpenXMemWalError {
  constructor(scope: 'delegate-minute' | 'account-minute' | 'account-hour', retryAfterMs: number) {
    super(MemWalErrorCode.RateLimit, `Rate limit reached (${scope})`, {
      retryAfterMs,
      details: { scope },
    });
    this.name = 'OpenXMemWalRateLimitError';
  }
}

export class OpenXMemWalAccountFrozenError extends OpenXMemWalError {
  constructor() {
    super(MemWalErrorCode.AccountFrozen, 'MemWal account is deactivated');
    this.name = 'OpenXMemWalAccountFrozenError';
  }
}

export class OpenXMemWalNoAccessError extends OpenXMemWalError {
  constructor() {
    super(MemWalErrorCode.NoAccess, 'Seal denied access (caller is not owner or registered delegate)');
    this.name = 'OpenXMemWalNoAccessError';
  }
}

export class OpenXMemWalCompatibilityError extends OpenXMemWalError {
  constructor(installed: string, required: string) {
    super(
      MemWalErrorCode.Compatibility,
      `MemWal SDK ${installed} is incompatible with relayer (requires ≥ ${required})`,
      { details: { installed, required } },
    );
    this.name = 'OpenXMemWalCompatibilityError';
  }
}

export class OpenXMemWalStorageQuotaError extends OpenXMemWalError {
  constructor(usedBytes: number, capBytes: number) {
    super(
      MemWalErrorCode.StorageQuota,
      `MemWal account storage at ${usedBytes}/${capBytes} bytes — write blocked`,
      { details: { usedBytes, capBytes } },
    );
    this.name = 'OpenXMemWalStorageQuotaError';
  }
}

export class OpenXMemWalInvalidConfigError extends OpenXMemWalError {
  constructor(message: string) {
    super(MemWalErrorCode.InvalidConfig, message);
    this.name = 'OpenXMemWalInvalidConfigError';
  }
}
