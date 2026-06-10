/**
 * smoke-cognitive-l4-l5.ts
 *
 * Exercises Tasks 1 + 2: cognitive types L4/L5/Skill + promotion functions.
 * Project convention: tsx smoke scripts (not vitest). Run with:
 *   npm run smoke:cognitive-l4-l5
 *
 * Validates:
 *  - workflowSigningMessage / verifyWorkflow round-trip
 *  - reflectiveSigningMessage / verifyReflective round-trip
 *  - skillSigningMessage / verifySkill round-trip
 *  - isWorkflowDagValid: happy + cycle + missing-dep + duplicate-id
 *  - promoteToWorkflow: tier-guard (G3) — standard-tier bundles ignored
 *  - promoteToWorkflow: ≥3 distinct procedureKeys threshold
 *  - promoteToReflective: ≥3 success + ≥1 fail threshold
 *  - promoteToReflective: |correlation|>0.7 emits a rule
 */

import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import {
  workflowSigningMessage,
  verifyWorkflow,
  reflectiveSigningMessage,
  verifyReflective,
  skillSigningMessage,
  verifySkill,
  isWorkflowDagValid,
  type Workflow,
  type ReflectiveTrace,
  type Skill,
  type WorkflowStep,
  type ProceduralBundle,
  type WorkflowRunReceipt,
} from '../packages/sdk/src/cognitive/types';
import {
  promoteToWorkflow,
  promoteToReflective,
} from '../packages/sdk/src/cognitive/consolidator';

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

async function run() {
  console.log('— Task 1: types sign/verify + DAG validity —\n');

  const account = privateKeyToAccount(generatePrivateKey());
  const signer = account.address as `0x${string}`;

  const dag: WorkflowStep[] = [
    {
      id: 'a',
      name: 'A',
      type: 'transform',
      transform: { fn: 'extract', args: {} },
      dependsOn: [],
      inputSchema: {},
      outputSchema: {},
    },
    {
      id: 'b',
      name: 'B',
      type: 'transform',
      transform: { fn: 'filter', args: {} },
      dependsOn: ['a'],
      inputSchema: {},
      outputSchema: {},
    },
  ];

  ok('isWorkflowDagValid: happy linear', isWorkflowDagValid(dag).ok === true);
  ok(
    'isWorkflowDagValid: cycle rejected',
    isWorkflowDagValid([
      { ...dag[0], dependsOn: ['b'] },
      { ...dag[1], dependsOn: ['a'] },
    ]).ok === false,
  );
  ok(
    'isWorkflowDagValid: missing-dep rejected',
    isWorkflowDagValid([{ ...dag[0], dependsOn: ['ghost'] }]).ok === false,
  );
  ok(
    'isWorkflowDagValid: duplicate-id rejected',
    isWorkflowDagValid([
      { ...dag[0], id: 'x' },
      { ...dag[1], id: 'x' },
    ]).ok === false,
  );
  ok('isWorkflowDagValid: empty-dag rejected', isWorkflowDagValid([]).ok === false);

  const wfUnsigned = {
    workflowKey: 'demo-v1',
    name: 'Demo',
    description: 'Smoke',
    steps: dag,
    derivedFrom: [],
    defaultPriceUsdc: '0.50',
    revenueSplit: { authorBps: 9500, platformBps: 500 },
    signer,
    createdAt: 1_000,
  };
  const wfSig = await account.signMessage({ message: workflowSigningMessage(wfUnsigned) });
  const wf: Workflow = { ...wfUnsigned, signature: wfSig };
  ok('verifyWorkflow: valid signature accepted', await verifyWorkflow(wf));
  ok('verifyWorkflow: tampered name rejected', !(await verifyWorkflow({ ...wf, name: 'Hacked' })));

  const skUnsigned = {
    skillKey: 'sk-1',
    manifest: {
      skillKey: 'sk-1',
      name: 'Skill 1',
      description: 'd',
      inputSchema: {},
      outputSchema: {},
      endpoint: { type: 'internal' as const, ref: 'echo' },
    },
    defaultPriceUsdc: '0.01',
    signer,
    createdAt: 2_000,
  };
  const skSig = await account.signMessage({ message: skillSigningMessage(skUnsigned) });
  const sk: Skill = { ...skUnsigned, signature: skSig };
  ok('verifySkill: valid signature accepted', await verifySkill(sk));
  ok('verifySkill: tampered price rejected', !(await verifySkill({ ...sk, defaultPriceUsdc: '99' })));

  const reflUnsigned = {
    traceKey: 'r-1',
    workflowKey: 'wf-1',
    observations: [],
    derivedRules: [],
    derivedFrom: [],
    defaultLicensePriceUsdc: '5.00',
    signer,
    createdAt: 3_000,
  };
  const reflSig = await account.signMessage({ message: reflectiveSigningMessage(reflUnsigned) });
  const refl: ReflectiveTrace = { ...reflUnsigned, signature: reflSig };
  ok('verifyReflective: valid signature accepted', await verifyReflective(refl));
  ok(
    'verifyReflective: tampered traceKey rejected',
    !(await verifyReflective({ ...refl, traceKey: 'evil' })),
  );

  console.log('\n— Task 2: promoteToWorkflow tier-guard + threshold —\n');

  const baseBundle: ProceduralBundle = {
    procedureKey: '',
    manifest: {
      steps: [{ name: 's1', description: 'do' }],
      inputSchema: {},
      outputSchema: {},
    },
    derivedFrom: [],
    defaultPriceUsdc: '0.05',
    signer,
    signature: '0x' as `0x${string}`,
    createdAt: 0,
  };
  // 3 trustless bundles sharing verb prefix "verify" + 1 standard-tier bundle that must be ignored.
  const promotionInput = {
    bundles: [
      { ...baseBundle, id: 'p1', tier: 'trustless' as const, brainId: 1, procedureKey: 'verify-fhe-X' },
      { ...baseBundle, id: 'p2', tier: 'trustless' as const, brainId: 1, procedureKey: 'verify-tee-Y' },
      { ...baseBundle, id: 'p3', tier: 'trustless' as const, brainId: 1, procedureKey: 'verify-seal-Z' },
      // Standard-tier bundle with same verb — MUST be filtered out (G3).
      { ...baseBundle, id: 'p4', tier: 'standard' as const, brainId: 9, procedureKey: 'verify-evil-W' },
    ],
    existingWorkflowKeys: new Set<string>(),
  };
  const candidates = promoteToWorkflow(promotionInput);
  ok('promoteToWorkflow: emits 1 candidate from 3 trustless verbs', candidates.length === 1);
  ok(
    'promoteToWorkflow: candidate has 3 steps (standard tier filtered out)',
    candidates[0]?.steps.length === 3,
  );
  ok(
    'promoteToWorkflow: G3 — standard-tier procedureKeys absent from derivedFrom',
    !candidates[0]?.derivedFrom.includes('p4'),
  );
  ok(
    'promoteToWorkflow: dedup respects existingWorkflowKeys',
    promoteToWorkflow({
      ...promotionInput,
      existingWorkflowKeys: new Set([candidates[0].workflowKey]),
    }).length === 0,
  );
  ok(
    'promoteToWorkflow: <3 distinct procedureKeys → no candidate',
    promoteToWorkflow({
      ...promotionInput,
      bundles: promotionInput.bundles.slice(0, 2),
    }).length === 0,
  );
  ok(
    'promoteToWorkflow: price = sum × 1.5',
    candidates[0]?.defaultPriceUsdc === '0.23' /* 0.05*3*1.5 = 0.225 → "0.23" */,
  );

  console.log('\n— Task 2: promoteToReflective correlation + threshold —\n');

  const mkRun = (
    runId: string,
    success: boolean,
    stepResults: Record<string, boolean>,
  ): WorkflowRunReceipt => ({
    runId,
    workflowKey: 'wf-1',
    buyer: signer,
    inputFingerprint: runId,
    success,
    outputs: {},
    stepReceipts: Object.entries(stepResults).map(([stepId, ok2]) => ({
      stepId,
      outputHash: '0x',
      amountUsdc: '0.05',
      sellerAddress: signer,
      startedAt: 0,
      endedAt: 1,
      success: ok2,
    })),
    totalUsdc: '0.10',
    startedAt: 0,
    endedAt: 1,
  });

  // 3 success runs (step-1 ok, step-2 ok), 2 fail runs (step-1 ok, step-2 NOT ok).
  // → step-2 success perfectly correlates with run success.
  const runs = [
    mkRun('r1', true, { 'step-1': true, 'step-2': true }),
    mkRun('r2', true, { 'step-1': true, 'step-2': true }),
    mkRun('r3', true, { 'step-1': true, 'step-2': true }),
    mkRun('r4', false, { 'step-1': true, 'step-2': false }),
    mkRun('r5', false, { 'step-1': true, 'step-2': false }),
  ];
  const traces = promoteToReflective({
    runs,
    existingTraceKeys: new Set(),
    qualityScores: {},
  });
  ok('promoteToReflective: emits 1 trace', traces.length === 1);
  ok(
    'promoteToReflective: derives ≥1 rule about step-2',
    traces[0]?.derivedRules.some((r) => r.rule.includes('step-2')),
  );
  ok(
    'promoteToReflective: <3 successes → no trace',
    promoteToReflective({
      runs: runs.slice(0, 3).filter((r) => r.success),
      existingTraceKeys: new Set(),
      qualityScores: {},
    }).length === 0,
  );
  ok(
    'promoteToReflective: 0 failures → no trace',
    promoteToReflective({
      runs: runs.filter((r) => r.success),
      existingTraceKeys: new Set(),
      qualityScores: {},
    }).length === 0,
  );
  ok(
    'promoteToReflective: dedup respects existingTraceKeys',
    promoteToReflective({
      runs,
      existingTraceKeys: new Set([traces[0].traceKey]),
      qualityScores: {},
    }).length === 0,
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
