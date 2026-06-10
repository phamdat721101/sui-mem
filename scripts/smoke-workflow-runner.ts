/**
 * smoke-workflow-runner.ts
 *
 * Exercises Tasks 4 + 5 — workflowRunner pure helpers + Adjustment 2 (G2)
 * Sui-resident assertion via a mock pool. No DB required to run.
 *
 *   npm run smoke:workflow-runner
 */

import {
  topoOrder,
  resolveStepInput,
  applyTransform,
  hashCanonical,
  WorkflowRunner,
  WorkflowRunnerError,
} from '../packages/api/src/services/workflowRunner';
import type { WorkflowStep } from '../packages/sdk/src/cognitive/types';

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

const mkStep = (id: string, dependsOn: string[] = [], type: WorkflowStep['type'] = 'transform'): WorkflowStep => ({
  id,
  name: id,
  type,
  transform: type === 'transform' ? { fn: 'merge', args: {} } : undefined,
  dependsOn,
  inputSchema: {},
  outputSchema: {},
});

console.log('— topoOrder —\n');

ok(
  'happy linear a → b → c',
  JSON.stringify(topoOrder([mkStep('a'), mkStep('b', ['a']), mkStep('c', ['b'])])) === '["a","b","c"]',
);

ok(
  'diamond a → {b,c} → d',
  (() => {
    const order = topoOrder([mkStep('a'), mkStep('b', ['a']), mkStep('c', ['a']), mkStep('d', ['b', 'c'])]);
    return order[0] === 'a' && order[3] === 'd' && order.includes('b') && order.includes('c');
  })(),
);

ok(
  'cycle throws',
  (() => {
    try {
      topoOrder([mkStep('a', ['b']), mkStep('b', ['a'])]);
      return false;
    } catch (e) {
      return /cycle/.test(String((e as Error).message));
    }
  })(),
);

console.log('\n— resolveStepInput —\n');

ok(
  'no deps → run input verbatim',
  JSON.stringify(resolveStepInput(mkStep('a'), { url: 'x' }, {})) === '{"url":"x"}',
);

ok(
  'single dep → upstream output',
  JSON.stringify(resolveStepInput(mkStep('b', ['a']), { url: 'x' }, { a: { html: '<p>' } })) === '{"html":"<p>"}',
);

ok(
  'multiple deps → merge under step ids',
  (() => {
    const out = resolveStepInput(
      mkStep('d', ['b', 'c']),
      {},
      { b: { x: 1 }, c: { y: 2 } },
    );
    return (out.b as any).x === 1 && (out.c as any).y === 2;
  })(),
);

console.log('\n— applyTransform —\n');

ok(
  'extract path',
  applyTransform(
    { ...mkStep('t'), transform: { fn: 'extract', args: { path: 'a.b.c' } } },
    { a: { b: { c: 42 } } },
  ) === 42,
);

ok(
  'filter by key/value',
  JSON.stringify(
    applyTransform(
      { ...mkStep('t'), transform: { fn: 'filter', args: { key: 'k', value: 1 } } },
      { items: [{ k: 1 }, { k: 2 }, { k: 1 }] },
    ),
  ) === '[{"k":1},{"k":1}]',
);

ok(
  'merge with',
  JSON.stringify(
    applyTransform(
      { ...mkStep('t'), transform: { fn: 'merge', args: { with: { extra: 'z' } } } },
      { a: 1 },
    ),
  ) === '{"a":1,"extra":"z"}',
);

ok(
  'split by separator',
  JSON.stringify(
    applyTransform(
      { ...mkStep('t'), transform: { fn: 'split', args: { separator: ',' } } },
      { text: 'a,b,c' },
    ),
  ) === '["a","b","c"]',
);

console.log('\n— hashCanonical determinism —\n');

ok(
  'same content → same hash regardless of key order',
  hashCanonical({ a: 1, b: 2 }) === hashCanonical({ b: 2, a: 1 }),
);
ok(
  'different content → different hash',
  hashCanonical({ a: 1 }) !== hashCanonical({ a: 2 }),
);

console.log('\n— Adjustment 2 (G2): NOT_SUI_RESIDENT guard —\n');

// Mock pool that returns a workflow row WITHOUT sui_object_id.
const standardTierRow = {
  id: 'wf-std-1',
  workflow_key: 'leaked-from-standard-tier',
  author_addr: '0xstandard',
  sui_object_id: '', // empty — would happen only via DB out-of-band insert
  manifest_blob_id: 'blob',
  name: 'leaked',
  description: '',
  steps: [mkStep('a')],
  default_price_usdc: '0',
  author_bps: 9500,
  platform_bps: 500,
  published: true,
  signer: '0x',
  signature: '0x',
};

const mockPool: any = {
  query: async (_sql: string, _params: any[]) => ({ rowCount: 1, rows: [standardTierRow] }),
  connect: async () => ({
    query: async () => ({ rowCount: 0, rows: [] }),
    release: () => {},
  }),
};

const runner = new WorkflowRunner({
  pool: mockPool,
  payStep: async () => ({ output: {}, amountUsdc: '0', sellerAddress: '' }),
});

async function checkG2() {
  let caught: WorkflowRunnerError | null = null;
  try {
    await runner.runWorkflow('wf-std-1', { input: {}, buyer: '0xbuyer' as `0x${string}` });
  } catch (e) {
    caught = e as WorkflowRunnerError;
  }
  ok('runWorkflow throws NOT_SUI_RESIDENT for empty sui_object_id', caught?.code === 'NOT_SUI_RESIDENT');
}

checkG2().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
});
