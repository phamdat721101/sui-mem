/**
 * lib/routerSafety.ts — global hardening for async route handlers.
 *
 * Two exports, one purpose: prevent a thrown promise rejection in any
 * route handler from killing the process via the unhandled-rejection
 * handler.
 *
 *   1. `hardenedRouter()` — drop-in replacement for `express.Router()`.
 *      Overrides `{get,post,patch,put,delete,use}` to wrap every async
 *      handler in a forwarder that converts Promise rejections to
 *      `next(err)`. Existing routes work unchanged — only the import
 *      changes.
 *
 *   2. `errorHandler` — global Express error middleware. Maps known
 *      error shapes (Postgres pg_codes, Sui x402, http err.status) to
 *      structured HTTP responses. Mount LAST in the middleware chain.
 *
 * SOLID:
 *   - SRP: this file owns "async-safe Router + error mapping". Nothing
 *     else.
 *   - DIP: handlers stay pure; cross-cutting failure handling lives here.
 *   - OCP: a new error code = one new branch in `errorHandler`. Routes
 *     never need to change.
 *   - "Do not repeat sample mistake": the unhandled-promise-rejection
 *     pattern that killed PATCH today (and would kill any other write)
 *     is now structurally impossible for handlers attached via this
 *     router.
 *
 * Express 4 does NOT auto-route async errors to the error middleware.
 * Express 5 does. We're on 4 → this wrapper is required.
 */

import {
  Router as ExpressRouter,
  type Router,
  type RequestHandler,
  type ErrorRequestHandler,
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import { logger } from './index';

// ─── Helper: wrap one handler so async throws → next(err) ───────────

function wrap(fn: RequestHandler): RequestHandler {
  return (req, res, next) => {
    try {
      const ret = fn(req, res, next) as unknown;
      if (ret && typeof (ret as Promise<unknown>).catch === 'function') {
        (ret as Promise<unknown>).catch(next);
      }
    } catch (err) {
      next(err as Error);
    }
  };
}

function wrapAll(handlers: RequestHandler[]): RequestHandler[] {
  return handlers.map((h) => (typeof h === 'function' ? wrap(h) : h));
}

// ─── hardenedRouter() — drop-in replacement for express.Router() ────

type RouteMethod = 'get' | 'post' | 'patch' | 'put' | 'delete' | 'use';
const METHODS: RouteMethod[] = ['get', 'post', 'patch', 'put', 'delete', 'use'];

export function hardenedRouter(): Router {
  const r = ExpressRouter();
  for (const m of METHODS) {
    const orig = (r[m] as (...args: unknown[]) => Router).bind(r);
    (r[m] as unknown) = (...args: unknown[]): Router => {
      // Express overloads: `.use(handler)`, `.use(path, ...handlers)`,
      // `.METHOD(path, ...handlers)`. The path is always a string|RegExp
      // when present; handlers are functions.
      const first = args[0];
      const hasPath = typeof first === 'string' || first instanceof RegExp || Array.isArray(first);
      const path = hasPath ? first : undefined;
      const handlers = (hasPath ? args.slice(1) : args) as RequestHandler[];
      const wrapped = wrapAll(handlers);
      return hasPath ? orig(path, ...wrapped) : orig(...wrapped);
    };
  }
  return r;
}

// ─── errorHandler — global error middleware ────────────────────────

interface PgError extends Error {
  code?: string;
  constraint?: string;
  column?: string;
  detail?: string;
  table?: string;
}

interface HttpError extends Error {
  status?: number;
  statusCode?: number;
  expose?: boolean;
}

export const errorHandler: ErrorRequestHandler = (err: unknown, req: Request, res: Response, next: NextFunction) => {
  // If a previous handler already wrote headers, defer to express default.
  if (res.headersSent) return next(err);

  const e = err as PgError & HttpError & { code?: string; message?: string };
  const code = e?.code;
  const msg = e?.message ?? String(err);
  const requestId = (req as Request & { requestId?: string }).requestId ?? null;

  // ─── Postgres data-validity errors → 400/409 ───────────────────
  if (code === '23514') {
    return res.status(400).json({
      error: 'check_violation',
      detail: msg,
      constraint: e.constraint,
      pg_code: code,
    });
  }
  if (code === '23502') {
    return res.status(400).json({
      error: 'not_null_violation',
      detail: msg,
      column: e.column,
      pg_code: code,
    });
  }
  if (code === '23503') {
    return res.status(400).json({
      error: 'foreign_key_violation',
      detail: msg,
      constraint: e.constraint,
      pg_code: code,
    });
  }
  if (code === '23505') {
    return res.status(409).json({
      error: 'unique_violation',
      detail: msg,
      constraint: e.constraint,
      pg_code: code,
    });
  }
  if (code === '22P02') {
    return res.status(400).json({
      error: 'invalid_text_representation',
      detail: msg,
      pg_code: code,
    });
  }

  // ─── Sui x402 / sponsor / payment errors → 503 ────────────────
  if (
    msg.includes('OPENX_LOOP_SPONSOR_PRIVATE_KEY') ||
    msg.includes('sponsor_gas_empty') ||
    msg.includes('suiX402Core')
  ) {
    logger.warn({ err: msg, path: req.path, requestId }, 'errorHandler:sponsor-or-config');
    return res.status(503).json({ error: 'paywall_unavailable', detail: msg });
  }

  // ─── Library errors that already carry an HTTP status ──────────
  const httpStatus = e.status ?? e.statusCode;
  if (typeof httpStatus === 'number' && httpStatus >= 400 && httpStatus < 600) {
    return res.status(httpStatus).json({ error: msg });
  }

  // ─── Default: 500 + structured log so genuine bugs surface ─────
  logger.error(
    { err: msg, stack: e?.stack, path: req.path, method: req.method, requestId },
    'errorHandler:unexpected',
  );
  return res.status(500).json({ error: 'internal_error', detail: msg });
};
