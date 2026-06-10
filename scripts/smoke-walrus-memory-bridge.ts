/**
 * smoke-walrus-memory-bridge.ts
 *
 * Verifies Adjustment 5 (G4 isolation) for WalrusMemoryBridge:
 *   1. Constructing with tier='standard' throws clear error.
 *   2. Constructing with tier='trustless' but no MemWal installed throws
 *      a clear actionable error.
 *
 *   npm run smoke:walrus-memory-bridge
 */

import { WalrusMemoryBridge } from '../packages/sdk/src/walrusMemoryBridge';

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

const baseCfg = {
  openxApiUrl: 'http://localhost:3001',
  walletAddress: '0xpham',
  memwalKey: '0x' + 'a'.repeat(64),
  memwalAccountId: '0xfake-account-id',
};

console.log('— WalrusMemoryBridge G4 isolation —\n');

// 1. Standard tier rejected.
try {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _bridge = new WalrusMemoryBridge({ ...baseCfg, tier: 'standard' });
  ok('rejects tier=standard', false);
} catch (e: any) {
  ok(
    'rejects tier=standard with clear message',
    /requires tier="trustless"/.test(String(e?.message)),
  );
}

// 2. tier=trustless but MemWal not installed → clear actionable error.
//    (We don't actually install @mysten-incubation/memwal in this repo's
//    devDeps, so this branch fires.)
try {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _bridge = new WalrusMemoryBridge({ ...baseCfg, tier: 'trustless' });
  ok('rejects missing peer-dep', false);
} catch (e: any) {
  const msg = String(e?.message);
  ok(
    'missing @mysten-incubation/memwal raises actionable install hint',
    /@mysten-incubation\/memwal/.test(msg) && /npm install/.test(msg),
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
