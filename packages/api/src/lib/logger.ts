import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import pino from 'pino';

/**
 * Structured logging + per-request correlation ID.
 *
 * SOLID:
 * - Single Responsibility: this file owns one concern — observable log output
 *   tagged with a stable correlation ID for the lifetime of a request.
 * - Open/Closed: callers consume `logger`/`getRequestId()`; new context fields
 *   are added by extending the AsyncLocalStorage payload, never by editing
 *   call sites.
 * - Dependency Inversion: routes depend on `logger`, not on pino directly.
 */

interface RequestContext {
  requestId: string;
  userAddress?: string;
  chain?: string;
}

const als = new AsyncLocalStorage<RequestContext>();

/** Returns the active request's correlation ID, or undefined outside a request. */
export function getRequestId(): string | undefined {
  return als.getStore()?.requestId;
}

/** Mutate the active request's context (e.g. once auth middleware resolves the wallet). */
export function setRequestContext(patch: Partial<Omit<RequestContext, 'requestId'>>): void {
  const store = als.getStore();
  if (store) Object.assign(store, patch);
}

/**
 * Pino instance with a mixin that injects the active correlation ID into every
 * log line — without callers having to remember.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: '@fhe-ai-context/api' },
  mixin: () => {
    const store = als.getStore();
    return store ? { requestId: store.requestId, userAddress: store.userAddress, chain: store.chain } : {};
  },
  // pretty-print in dev only; raw JSON in prod for log shipping.
  transport:
    process.env.NODE_ENV === 'production'
      ? undefined
      : { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' } },
});

/**
 * Express middleware: stamp every request with a stable correlation ID and run
 * the rest of the pipeline inside an AsyncLocalStorage scope.
 */
export function correlationId() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = (req.header('x-request-id') ?? '').trim();
    const requestId = incoming || randomUUID();
    res.setHeader('x-request-id', requestId);
    als.run({ requestId }, () => {
      // Pull common context out of headers so log lines carry it automatically.
      setRequestContext({
        userAddress: (req.header('x-wallet-address') ?? '').toLowerCase() || undefined,
        chain: req.header('x-chain') ?? undefined,
      });
      logger.info({ method: req.method, path: req.path }, 'request:start');
      const start = Date.now();
      res.on('finish', () => {
        logger.info({ status: res.statusCode, durationMs: Date.now() - start }, 'request:end');
      });
      next();
    });
  };
}
