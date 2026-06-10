/**
 * smoke-memwal-adapter.ts
 *
 * Validates `OpenXMemWalAdapter` against the MemWal testnet relayer.
 *
 *   npm run smoke:memwal-adapter
 *
 * Test cases (PRD-06 §8):
 *  1. Adapter rejects empty delegate-key pool (config validation).
 *  2. Adapter rejects 21+ delegate keys (MemWal hard cap mirroring).
 *  3. Without `MEMWAL_PEERDEP_ENABLED=true` the adapter throws
 *     `OpenXMemWalUpstreamMissingError` with an actionable hint.
 *  4. With the peer-dep flag and a real testnet delegate, `health()` returns ok.
 *  5. Per-call rate-limit guard rejects the 31st write within a minute on a
 *     single delegate (in-memory bucket, deterministic — no network needed).
 *  6. Payment-gate denial throws `OpenXMemWalPaymentDeniedError`.
 *  7. Round-trip: remember → recall returns ≥1 hit (only when
 *     OPENX_MEMWAL_DELEGATE_PRIVATE_KEYS + MEMWAL_ACCOUNT_ID are set).
 *
 * The script skips network-touching cases cleanly when the env block is
 * not configured, so it stays green in CI without a relayer.
 */

import {
  OpenXMemWalAdapter,
  OpenXMemWalInvalidConfigError,
  OpenXMemWalPaymentDeniedError,
  OpenXMemWalRateLimitError,
  OpenXMemWalUpstreamMissingError,
} from '../packages/sdk/src/memwal';

const accountId = process.env.MEMWAL_ACCOUNT_ID ?? '';
const delegateKeys = (process.env.OPENX_MEMWAL_DELEGATE_PRIVATE_KEYS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const peerDepOn = process.env.MEMWAL_PEERDEP_ENABLED === 'true';
const liveReady = peerDepOn && accountId && delegateKeys.length > 0;

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

async function expectThrow<T>(
  name: string,
  fn: () => Promise<T>,
  match: (e: unknown) => boolean,
) {
  try {
    await fn();
    ok(name, false, 'expected throw, got resolved value');
  } catch (e) {
    ok(name, match(e), e);
  }
}

(async () => {
  console.log('— OpenXMemWalAdapter smoke —\n');
  console.log(
    `peer-dep flag: ${peerDepOn ? 'on' : 'off'} | account: ${
      accountId ? 'set' : 'unset'
    } | delegates: ${delegateKeys.length}`,
  );

  // 1. Empty delegate pool — config validation
  await expectThrow(
    'rejects empty delegate-key pool',
    () =>
      OpenXMemWalAdapter.create({
        network: 'testnet',
        walletAddress: '0xpham',
        accountId: '0xfake',
        delegateKeys: [],
      }),
    (e) => e instanceof OpenXMemWalInvalidConfigError,
  );

  // 2. 21 keys — MemWal hard cap
  await expectThrow(
    'rejects pool size > 20',
    () =>
      OpenXMemWalAdapter.create({
        network: 'testnet',
        walletAddress: '0xpham',
        accountId: '0xfake',
        delegateKeys: Array.from({ length: 21 }, (_, i) => `0x${'a'.repeat(63)}${i}`),
      }),
    (e) => e instanceof OpenXMemWalInvalidConfigError,
  );

  // 3. Peer-dep gate when flag is off
  if (!peerDepOn) {
    await expectThrow(
      'throws OpenXMemWalUpstreamMissingError when MEMWAL_PEERDEP_ENABLED is off',
      () =>
        OpenXMemWalAdapter.create({
          network: 'testnet',
          walletAddress: '0xpham',
          accountId: '0xfake',
          delegateKeys: ['0x' + 'a'.repeat(64)],
        }),
      (e) => e instanceof OpenXMemWalUpstreamMissingError,
    );
  } else {
    console.log('  ⏭  peer-dep on — skipping "throws when flag off" case');
  }

  // 5. Rate-limit guard math (network-free; uses the in-memory bucket).
  //    We construct only the limiter directly to avoid the peer-dep dance.
  {
    const { RateLimitGuard } = await import('../packages/sdk/src/memwal/rateLimitGuard');
    const limiter = new RateLimitGuard();
    let rejected = false;
    try {
      for (let i = 0; i < 7; i++) {
        // 7 × 5 pts = 35 pts > 30 pts/min/delegate cap → 7th throws
        await limiter.charge('0xfake-acc', 'fake-del-hash', 5);
      }
    } catch (e) {
      rejected = e instanceof OpenXMemWalRateLimitError;
    }
    ok('rate-limit guard blocks > 30 pts/min/delegate', rejected);
  }

  // 6. Payment-gate denial path — synthetic adapter.
  if (peerDepOn) {
    const adapter = await OpenXMemWalAdapter.create({
      network: 'testnet',
      walletAddress: '0xpham',
      accountId: accountId || '0xfake',
      delegateKeys: delegateKeys.length ? delegateKeys.slice(0, 1) : ['0x' + 'a'.repeat(64)],
      paymentGate: async () => ({ allowed: false, reason: 'no funds' }),
    }).catch((e) => e);

    if (adapter instanceof OpenXMemWalAdapter) {
      await expectThrow(
        'paymentGate denial → OpenXMemWalPaymentDeniedError',
        () => adapter.recall('test'),
        (e) => e instanceof OpenXMemWalPaymentDeniedError,
      );
    } else {
      console.log('  ⏭  paymentGate test skipped (adapter init failed in non-live env)');
    }
  } else {
    console.log('  ⏭  paymentGate test skipped (peer-dep off)');
  }

  // 7. Live round-trip — remember → recall.
  if (liveReady) {
    const adapter = await OpenXMemWalAdapter.create({
      network: 'testnet',
      walletAddress: process.env.PHAM_SUI_ADDRESS ?? '0xpham',
      accountId,
      delegateKeys,
      namespace: 'openx-smoke',
    });
    const text = `smoke run ${new Date().toISOString()}`;
    const w = await adapter.remember(text);
    ok('live remember returns blob_id or job_id', !!(w.blob_id || w.job_id), w);

    const r = await adapter.recall('smoke run', { limit: 3 });
    ok('live recall returns ≥1 result', r.results.length > 0, r);

    const h = await adapter.health();
    ok('live health is ok', h.status === 'ok', h);
  } else {
    console.log('  ⏭  live cases skipped — set MEMWAL_PEERDEP_ENABLED=true + MEMWAL_ACCOUNT_ID + OPENX_MEMWAL_DELEGATE_PRIVATE_KEYS');
  }

  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})();
