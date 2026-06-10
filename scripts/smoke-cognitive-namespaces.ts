/**
 * smoke-cognitive-namespaces.ts
 *
 * Deterministic checks for the cognitive L1–L5 namespace formatter (PRD-10).
 * No network, no DB.
 *
 *   npm run smoke:cognitive-namespaces
 */

import {
  cogNamespace,
  parseCogNamespace,
  COGNITIVE_LEVEL_LABELS,
  COGNITIVE_DEFAULT_PRICES_USDC,
} from '../packages/sdk/src/cognitive/namespaces';

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

console.log('— cognitive namespace smoke —\n');

// Format
ok('L2 builds cog-l2-<brain>', cogNamespace(2, 'brainA') === 'cog-l2-brainA');
ok('L3 builds cog-l3-<brain>', cogNamespace(3, 'foo') === 'cog-l3-foo');
ok('L5 builds cog-l5-<brain>', cogNamespace(5, 'pham') === 'cog-l5-pham');
ok(
  'L1 builds cog-l1-<brain>-<session>',
  cogNamespace(1, 'b', 'sess1') === 'cog-l1-b-sess1',
);

// L1 without sessionId should throw
let threw = false;
try {
  cogNamespace(1, 'brainA');
} catch {
  threw = true;
}
ok('L1 without sessionId throws', threw);

// Parse round-trip
const r2 = parseCogNamespace('cog-l2-brainA');
ok('parse L2', r2?.level === 2 && r2.brainId === 'brainA' && !r2.sessionId);

const r1 = parseCogNamespace('cog-l1-foo-sess1');
ok(
  'parse L1 with session',
  r1?.level === 1 && r1.brainId === 'foo' && r1.sessionId === 'sess1',
);

ok(
  'parse rejects non-cognitive namespace',
  parseCogNamespace('foo-l2-bar') === null,
);

ok('parse rejects L1 without session', parseCogNamespace('cog-l1-bar') === null);

// Defaults / labels are stable
ok('label L5 is reflective', COGNITIVE_LEVEL_LABELS[5] === 'reflective');
ok('default price L5 is $5.00', COGNITIVE_DEFAULT_PRICES_USDC[5] === '5.00');

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
