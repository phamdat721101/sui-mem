/**
 * Public barrel for the api's `lib/` directory.
 *
 * Server-coupled concerns stay here (logger, observability, lifecycle).
 * Runtime-neutral primitives (resilientCall, resumeToken) come from
 * `@fhe-ai-context/runtime-utils` so the SDK and any agent demos can reuse
 * the same code without an Express dependency.
 */

import {
  resilientCall as baseResilientCall,
  type ResilientOptions,
} from '@fhe-ai-context/runtime-utils';
import { logger } from './logger';

export { logger, correlationId, getRequestId, setRequestContext } from './logger';
export {
  metricsMiddleware,
  metricsHandler,
  healthHandler,
  registerHealthProbe,
  type HealthProbe,
  type DepStatus,
} from './observability';
export { installLifecycle } from './lifecycle';

// Re-export runtime-utils primitives — single source of truth.
export {
  CircuitOpenError,
  getBreakerSnapshot,
  signResumeToken,
  verifyResumeToken,
  InvalidResumeToken,
  type ResilientOptions,
} from '@fhe-ai-context/runtime-utils';

/**
 * api-side `resilientCall` with the Pino logger pre-bound. Callers in routes
 * never have to pass a logger; correlation IDs propagate automatically through
 * the AsyncLocalStorage mixin in `logger.ts`.
 */
export function resilientCall<T>(
  opts: Omit<ResilientOptions, 'logger'> & { logger?: ResilientOptions['logger'] },
  fn: () => Promise<T>,
): Promise<T> {
  return baseResilientCall({ ...opts, logger: opts.logger ?? logger }, fn);
}
