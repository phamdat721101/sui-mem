import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import { logger, getRequestId } from './logger';

/**
 * Process lifecycle: crash dump + graceful shutdown.
 *
 * SOLID — Single Responsibility: everything here is about *the Node process*,
 * not about any particular request. Per-request resilience lives in
 * `resilientCall`; per-request observability lives in `observability`.
 */

const CRASH_DIR = process.env.CRASH_DIR ?? '/tmp/fhe-brain-crashes';

function ensureDir(p: string): void {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch {
    // ignore — best-effort
  }
}

function dumpCrash(kind: 'uncaught' | 'unhandled', err: unknown): string {
  ensureDir(CRASH_DIR);
  const file = path.join(CRASH_DIR, `${kind}-${Date.now()}.json`);
  const dump = {
    kind,
    requestId: getRequestId(),
    error: err instanceof Error ? { message: err.message, stack: err.stack, name: err.name } : { value: String(err) },
    pid: process.pid,
    nodeVersion: process.version,
    when: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(file, JSON.stringify(dump, null, 2));
  } catch {
    // Last-ditch: log only
  }
  return file;
}

/**
 * Wire crash handlers + graceful shutdown for the given HTTP server.
 *
 * - `uncaughtException` / `unhandledRejection`: dump state then exit(1) so the
 *   supervisor (PM2 / Docker) restarts us.
 * - `SIGTERM` / `SIGINT`: stop accepting new connections, drain in-flight,
 *   exit(0).
 */
export function installLifecycle(server: Server): void {
  const onCrash = (kind: 'uncaught' | 'unhandled') => (err: unknown) => {
    const file = dumpCrash(kind, err);
    logger.fatal({ kind, dump: file, err: (err as Error)?.message }, 'crash');
    // Give logger a tick to flush, then exit.
    setTimeout(() => process.exit(1), 100);
  };

  process.on('uncaughtException', onCrash('uncaught'));
  process.on('unhandledRejection', onCrash('unhandled'));

  let shuttingDown = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown:start');
    server.close((err) => {
      if (err) {
        logger.error({ err: err.message }, 'shutdown:server_close_failed');
        process.exit(1);
      }
      logger.info('shutdown:complete');
      process.exit(0);
    });
    // Hard timeout in case in-flight requests stall.
    setTimeout(() => {
      logger.error('shutdown:timeout_force_exit');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
}
