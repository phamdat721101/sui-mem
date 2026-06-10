/**
 * smoke-memwal-billing.ts
 *
 * Deterministic checks for the settlement worker + volume dial. No live
 * network, no live Postgres — uses an in-memory Pool stub so the smoke is
 * fast (≤ 1s) and fits cleanly into `run-all-smokes.sh`.
 *
 *   npm run smoke:memwal-billing
 *
 * Cases:
 *  1. Volume dial — 0..99 → 500 bps, 100..999 → 400, 1k..9999 → 300, 10k+ → 200.
 *  2. Worker.tick groups paid queries by brain, computes seller/operator splits
 *     and inserts a settlement row + tags the queries.
 *  3. No-op when MEMWAL_SETTLEMENT_ENABLED=false.
 */

import { operatorBpsFor, MemWalSettlementWorker } from '../packages/api/src/services/memwalSettlement';

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, info?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}`, info ?? '');
  }
}

// ─── 1. Volume dial transitions ─────────────────────────────────────

console.log('— MemWal billing smoke —\n');

ok('dial: 0 queries → 500 bps (5%)', operatorBpsFor(0) === 500);
ok('dial: 99 queries → 500 bps', operatorBpsFor(99) === 500);
ok('dial: 100 queries → 400 bps (4%)', operatorBpsFor(100) === 400);
ok('dial: 999 queries → 400 bps', operatorBpsFor(999) === 400);
ok('dial: 1_000 queries → 300 bps (3%)', operatorBpsFor(1_000) === 300);
ok('dial: 10_000 queries → 200 bps (2%)', operatorBpsFor(10_000) === 200);
ok('dial: 1_000_000 queries → 200 bps (cap)', operatorBpsFor(1_000_000) === 200);

// ─── 2. Worker tick logic with a Pool stub ──────────────────────────

interface QueryRow {
  brain_sui_object_id: string;
  amount_usdc: string;
  query_count: string;
  seller_wallet: string;
}

class StubClient {
  inserts: Array<{ table: string; values: unknown[] }> = [];
  updates: Array<{ table: string; where: unknown[] }> = [];
  begun = 0;
  committed = 0;
  rolledBack = 0;
  released = 0;
  async query(sql: string, vals?: unknown[]) {
    if (/^BEGIN/i.test(sql.trim())) {
      this.begun++;
      return { rows: [] };
    }
    if (/^COMMIT/i.test(sql.trim())) {
      this.committed++;
      return { rows: [] };
    }
    if (/^ROLLBACK/i.test(sql.trim())) {
      this.rolledBack++;
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO memwal_revenue_settlements')) {
      this.inserts.push({ table: 'memwal_revenue_settlements', values: vals ?? [] });
      return { rows: [] };
    }
    if (sql.includes('UPDATE memwal_paid_queries')) {
      this.updates.push({ table: 'memwal_paid_queries', where: vals ?? [] });
      return { rows: [] };
    }
    return { rows: [] };
  }
  release() {
    this.released++;
  }
}

class StubPool {
  pending: QueryRow[] = [];
  rolling = new Map<string, number>();
  client = new StubClient();
  async connect() {
    return this.client;
  }
  async query<T>(sql: string, params?: unknown[]) {
    if (sql.includes('FROM memwal_paid_queries q\n       JOIN memwal_marketplace_brains b ON b.sui_object_id = q.brain_sui_object_id\n       WHERE q.settlement_tx_hash IS NULL')) {
      return { rows: this.pending as unknown as T[] };
    }
    if (sql.includes('SELECT COUNT(*)::text AS count')) {
      const wallet = (params?.[0] as string) ?? '';
      return { rows: [{ count: String(this.rolling.get(wallet) ?? 0) }] as unknown as T[] };
    }
    return { rows: [] as T[] };
  }
}

(async () => {
  const stub = new StubPool();
  // Two brains, three paid queries each.
  stub.pending = [
    {
      brain_sui_object_id: '0xbrainA',
      amount_usdc: '0.15', // 3 × $0.05
      query_count: '3',
      seller_wallet: '0xseller_a',
    },
    {
      brain_sui_object_id: '0xbrainB',
      amount_usdc: '5.00', // 1 × $5.00 (L5 reflective)
      query_count: '1',
      seller_wallet: '0xseller_b',
    },
  ];
  // Seller A is in tier-1 (≥100 30d queries → 4%), seller B in tier-0 (5%).
  stub.rolling.set('0xseller_a', 250);
  stub.rolling.set('0xseller_b', 5);

  const worker = new MemWalSettlementWorker({
    pool: stub as unknown as never,
    intervalMs: 999_999, // never auto-ticks; we drive .tick() manually
    enabled: true,
  });
  const stats = await worker.tick();

  ok('worker batched both brains', stats.batches === 2, stats);
  ok('worker counted 4 queries total', stats.queries === 4, stats);
  ok('two settlement rows inserted', stub.client.inserts.length === 2, stub.client.inserts.length);
  ok('two settlement updates ran', stub.client.updates.length === 2, stub.client.updates.length);
  ok('begun==committed (atomic)', stub.client.begun === stub.client.committed && stub.client.committed === 2);

  // Inspect insert values for split correctness.
  const ins = stub.client.inserts.map((r) => r.values);
  // Row layout (matches recordSettlement):
  //   $1 brain, $2 settlement_tx_hash, $3 total_usdc, $4 query_count,
  //   $5 seller_wallet, $6 seller_amount_usdc, $7 operator_amount_usdc, $8 operator_bps
  const a = ins.find((v) => v[0] === '0xbrainA')!;
  const b = ins.find((v) => v[0] === '0xbrainB')!;
  ok('brainA bps = 400 (seller 250 queries → tier1)', a[7] === 400, a);
  ok('brainB bps = 500 (seller 5 queries → tier0)', b[7] === 500, b);
  ok('brainA seller cut = $0.144 (96% of $0.15)', Math.abs(Number(a[5]) - 0.144) < 1e-9, a[5]);
  ok('brainA operator cut = $0.006 (4%)', Math.abs(Number(a[6]) - 0.006) < 1e-9, a[6]);
  ok('brainB seller cut = $4.75 (95% of $5.00)', Math.abs(Number(b[5]) - 4.75) < 1e-9, b[5]);

  // Disabled worker no-ops.
  const stub2 = new StubPool();
  const wDisabled = new MemWalSettlementWorker({
    pool: stub2 as unknown as never,
    enabled: false,
  });
  wDisabled.start(); // should log "disabled" and do nothing
  ok('disabled worker does not connect', stub2.client.released === 0);

  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})();
