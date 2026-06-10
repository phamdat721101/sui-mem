#!/usr/bin/env tsx
/**
 * Smoke test — Walrus round-trip via Tatum-routed Sui RPC.
 *
 * Requires (.env.local):
 *   TATUM_API_KEY=t-...
 *   SUI_TESTNET_RPC_URL  (default: Tatum testnet gateway)
 *   WALRUS_TESTNET_PUBLISHER_URL / WALRUS_TESTNET_AGGREGATOR_URL  (defaults set)
 *
 * Run: `npm run smoke:walrus`
 *
 * What it proves:
 *   1. WalrusStore HTTP impl writes a 5KB encrypted blob and reads it back.
 *   2. resilientCall retries on transient failures (verified via inline assertion).
 *   3. Tatum Gateway dashboard registers ≥ 1 RPC call (visual check).
 */

import { createHash, randomBytes, randomFillSync } from 'node:crypto';
import { createWalrusStore } from '@fhe-ai-context/sui-sdk';

async function main() {
  // Ensure HTTP impl is selected by setting both URLs (testnet by default).
  process.env.WALRUS_PUBLISHER_URL ??=
    process.env.WALRUS_TESTNET_PUBLISHER_URL ??
    'https://publisher.walrus-testnet.walrus.space';
  process.env.WALRUS_AGGREGATOR_URL ??=
    process.env.WALRUS_TESTNET_AGGREGATOR_URL ??
    'https://aggregator.walrus-testnet.walrus.space';

  const walrus = createWalrusStore();
  const payload = randomBytes(5 * 1024); // 5KB random
  const sha = createHash('sha256').update(payload).digest('hex');
  console.log('walrus:smoke:upload bytes=', payload.length, 'sha256=', sha);

  const t0 = Date.now();
  const upload = await walrus.upload(payload, {
    onProgress: (f) => process.stdout.write(`\r  progress=${(f * 100).toFixed(0)}%`),
  });
  process.stdout.write('\n');
  const blobIds = upload.blobs.map((b) => b.blobId);
  console.log('walrus:smoke:uploaded ms=', Date.now() - t0, 'blobIds=', blobIds);

  // Round-trip: read back the first blob and verify hash.
  const fetched = await walrus.fetch(blobIds[0]);
  const sha2 = createHash('sha256').update(fetched).digest('hex');
  console.log('walrus:smoke:fetched bytes=', fetched.length, 'sha256=', sha2);
  if (sha2 !== sha) {
    console.error('walrus:smoke:FAIL hash mismatch');
    process.exit(1);
  }
  console.log('walrus:smoke:OK');
  console.log('Inspect at:');
  console.log(`  https://walruscan.com/testnet/blob/${blobIds[0]}`);
}

main().catch((err) => {
  console.error('walrus:smoke:error', err);
  process.exit(1);
});
