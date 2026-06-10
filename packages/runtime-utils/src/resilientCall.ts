/**
 * Resilient external call: retry + circuit breaker, scoped per dependency name.
 *
 * Runtime-neutral — works in Node (api server, agent demos) and browsers (SDK
 * direct calls to Walrus / Seal key servers). Logger is dependency-injected so
 * consumers wire their preferred logger (Pino, console, structured browser log).
 *
 * SOLID:
 * - Single Responsibility: this module governs *how* we call flaky things.
 * - Open/Closed: new dependencies do not require changes here; pass a new `name`.
 * - Dependency Inversion: callers pass the function and the logger; we never
 *   know what the dep or the logger really are.
 */

/** Minimal logger contract — Pino instances and console-shaped wrappers both fit. */
export interface ResilientLogger {
  warn(payload: object, msg?: string): void;
  info(payload: object, msg?: string): void;
  error(payload: object, msg?: string): void;
}

/** No-op default — overridden by consumers in normal use. */
export const noopLogger: ResilientLogger = {
  warn() {},
  info() {},
  error() {},
};

export interface ResilientOptions {
  /** Stable dependency name used in metrics + logs (e.g. 'bedrock', 'walrus'). */
  name: string;
  /** Total attempts including the first. Defaults to 3. */
  maxAttempts?: number;
  /** Base delay for exponential backoff in ms. Defaults to 250. */
  baseDelayMs?: number;
  /** Cap on backoff delay in ms. Defaults to 4_000. */
  maxDelayMs?: number;
  /** Failures within `windowMs` that open the circuit. Defaults to 5. */
  failureThreshold?: number;
  /** Cooldown before the circuit moves from OPEN to HALF_OPEN. Defaults to 30_000. */
  cooldownMs?: number;
  /** Logger to receive retry/breaker events. Defaults to a no-op. */
  logger?: ResilientLogger;
}

type State = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface BreakerState {
  state: State;
  consecutiveFailures: number;
  openedAt: number;
}

const breakers = new Map<string, BreakerState>();

/** Snapshot of all breakers — consumed by `/health` and `/metrics`. */
export function getBreakerSnapshot(): Record<string, BreakerState> {
  return Object.fromEntries(breakers);
}

function getBreaker(name: string): BreakerState {
  let b = breakers.get(name);
  if (!b) {
    b = { state: 'CLOSED', consecutiveFailures: 0, openedAt: 0 };
    breakers.set(name, b);
  }
  return b;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class CircuitOpenError extends Error {
  constructor(name: string) {
    super(`Circuit OPEN for ${name}`);
    this.name = 'CircuitOpenError';
  }
}

/**
 * Run `fn` with retry + circuit-breaker semantics tagged under `opts.name`.
 * See `ResilientOptions` for tuning knobs.
 */
export async function resilientCall<T>(opts: ResilientOptions, fn: () => Promise<T>): Promise<T> {
  const {
    name,
    maxAttempts = 3,
    baseDelayMs = 250,
    maxDelayMs = 4_000,
    failureThreshold = 5,
    cooldownMs = 30_000,
    logger = noopLogger,
  } = opts;

  const breaker = getBreaker(name);

  if (breaker.state === 'OPEN') {
    if (Date.now() - breaker.openedAt < cooldownMs) {
      throw new CircuitOpenError(name);
    }
    breaker.state = 'HALF_OPEN';
    logger.warn({ dep: name }, 'breaker:half_open');
  }

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const out = await fn();
      if (breaker.state !== 'CLOSED') logger.info({ dep: name }, 'breaker:closed');
      breaker.state = 'CLOSED';
      breaker.consecutiveFailures = 0;
      return out;
    } catch (err) {
      lastErr = err;
      breaker.consecutiveFailures++;
      logger.warn(
        { dep: name, attempt, maxAttempts, err: (err as Error)?.message },
        'resilientCall:attempt_failed',
      );

      if (breaker.consecutiveFailures >= failureThreshold && breaker.state !== 'OPEN') {
        breaker.state = 'OPEN';
        breaker.openedAt = Date.now();
        logger.error({ dep: name }, 'breaker:open');
      }

      if (attempt === maxAttempts) break;

      const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const delay = Math.floor(Math.random() * exp);
      await sleep(delay);
    }
  }
  throw lastErr;
}
