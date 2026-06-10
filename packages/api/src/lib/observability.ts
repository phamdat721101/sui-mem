import type { Request, Response, RequestHandler } from 'express';
import client from 'prom-client';
import type { Pool } from 'pg';
import { getBreakerSnapshot } from '@fhe-ai-context/runtime-utils';
import { logger } from './logger';

/**
 * Observability — `/metrics` (Prometheus) + `/health` (dependency probes).
 *
 * SOLID:
 *  - SRP: this file owns the *outward-facing* observability endpoints.
 *  - OCP: dependency probes register via `registerHealthProbe`, not by
 *    editing this file.
 *  - LSP: every probe satisfies the same `HealthProbe` contract.
 */

const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'path', 'status'] as const,
  registers: [registry],
});

export const httpRequestDurationMs = new client.Histogram({
  name: 'http_request_duration_ms',
  help: 'HTTP request duration in milliseconds',
  labelNames: ['method', 'path', 'status'] as const,
  buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
  registers: [registry],
});

export const v3RailReceiptsTotal = new client.Counter({
  name: 'v3_rail_receipts_total',
  help: 'Total v3 paid agent calls per rail',
  labelNames: ['rail'] as const,
  registers: [registry],
});

export const v3PayLatencyMs = new client.Histogram({
  name: 'v3_pay_latency_ms',
  help: 'PayRouter rail dispatch latency',
  labelNames: ['rail'] as const,
  buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000],
  registers: [registry],
});

/** Express middleware that records request count + duration. Mount once near the top. */
export function metricsMiddleware(): RequestHandler {
  return (req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const labels = { method: req.method, path: req.route?.path ?? req.path, status: String(res.statusCode) };
      httpRequestsTotal.inc(labels);
      httpRequestDurationMs.observe(labels, Date.now() - start);
    });
    next();
  };
}

export const metricsHandler: RequestHandler = async (_req, res) => {
  res.setHeader('Content-Type', registry.contentType);
  res.send(await registry.metrics());
};

// ─── Health ──────────────────────────────────────────────────────────────

export type DepStatus = 'ok' | 'degraded' | 'down';

export interface HealthProbe {
  name: string;
  check: () => Promise<DepStatus>;
}

const probes: HealthProbe[] = [];

export function registerHealthProbe(probe: HealthProbe): void {
  probes.push(probe);
}

async function runProbe(probe: HealthProbe): Promise<DepStatus> {
  try {
    return await Promise.race<DepStatus>([
      probe.check(),
      new Promise<DepStatus>((_, reject) => setTimeout(() => reject(new Error('probe timeout')), 1_000)),
    ]);
  } catch (err) {
    logger.warn({ dep: probe.name, err: (err as Error)?.message }, 'health:probe_failed');
    return 'down';
  }
}

export const healthHandler: RequestHandler = async (_req: Request, res: Response) => {
  const deps: Record<string, DepStatus> = {};
  const breakers = getBreakerSnapshot();
  for (const [name, b] of Object.entries(breakers)) {
    deps[name] = b.state === 'OPEN' ? 'degraded' : 'ok';
  }
  await Promise.all(
    probes.map(async (p) => {
      const status = await runProbe(p);
      if (deps[p.name] !== 'down') deps[p.name] = status;
    }),
  );
  const overall: DepStatus = Object.values(deps).reduce<DepStatus>(
    (worst, current) =>
      current === 'down' ? 'down' : current === 'degraded' ? (worst === 'down' ? 'down' : 'degraded') : worst,
    'ok',
  );
  res.status(overall === 'down' ? 503 : 200).json({ status: overall, deps });
};

// ─── KPI gauges (Sui-only) ───────────────────────────────────────────────
//
// Kept compact: 6 gauges that matter for the MemWal product.
//   - sellers, brains earning, buying agents
//   - settled USDC + 24h
//   - mock fallback rate

const KPI_NAMES = [
  'kpi_seller_wallets_total',
  'kpi_brains_earning_total',
  'kpi_buying_agent_wallets_total',
  'kpi_settled_usdc_total',
  'kpi_settled_usdc_24h',
  'kpi_paid_calls_24h',
] as const;

export type KpiName = (typeof KPI_NAMES)[number];

const kpiGauges = Object.fromEntries(
  KPI_NAMES.map((name) => [
    name,
    new client.Gauge({ name, help: name.replace(/_/g, ' '), registers: [registry] }),
  ]),
) as Record<KpiName, client.Gauge>;

export async function refreshKpiGauges(pool: Pool): Promise<Record<KpiName, number>> {
  const q = (sql: string) => pool.query(sql).then((r) => r.rows);
  try {
    const [sellerWallets, brainsEarning, buyingAgents, settledUsdc, settledUsdc24h, calls24h] = await Promise.all([
      q(`SELECT COUNT(DISTINCT owner_address)::int AS n FROM brains`),
      q(
        `SELECT COUNT(*)::int AS n FROM (
           SELECT agent_id FROM paid_calls
            WHERE method != 'free'
            GROUP BY agent_id HAVING COUNT(DISTINCT buyer) >= 1
         ) s`,
      ),
      q(`SELECT COUNT(DISTINCT buyer)::int AS n FROM paid_calls WHERE method != 'free'`),
      q(`SELECT COALESCE(SUM(amount_usdc), 0)::float AS n FROM paid_calls WHERE method != 'free'`),
      q(
        `SELECT COALESCE(SUM(amount_usdc), 0)::float AS n FROM paid_calls
          WHERE method != 'free' AND created_at > now() - interval '24 hours'`,
      ),
      q(`SELECT COUNT(*)::int AS n FROM paid_calls WHERE created_at > now() - interval '24 hours'`),
    ]);
    const values: Record<KpiName, number> = {
      kpi_seller_wallets_total: Number(sellerWallets[0]?.n ?? 0),
      kpi_brains_earning_total: Number(brainsEarning[0]?.n ?? 0),
      kpi_buying_agent_wallets_total: Number(buyingAgents[0]?.n ?? 0),
      kpi_settled_usdc_total: Number(settledUsdc[0]?.n ?? 0),
      kpi_settled_usdc_24h: Number(settledUsdc24h[0]?.n ?? 0),
      kpi_paid_calls_24h: Number(calls24h[0]?.n ?? 0),
    };
    for (const [name, val] of Object.entries(values)) {
      kpiGauges[name as KpiName].set(Number.isFinite(val) ? val : 0);
    }
    return values;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'kpi:refresh:failed');
    const zero: Record<KpiName, number> = Object.fromEntries(KPI_NAMES.map((n) => [n, 0])) as Record<KpiName, number>;
    return zero;
  }
}
