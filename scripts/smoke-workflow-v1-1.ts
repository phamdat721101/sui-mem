#!/usr/bin/env ts-node
/**
 * scripts/smoke-workflow-v1-1.ts — PRD-W v1.1 spine smoke gate.
 *
 * Verifies (no network calls, pure unit-style):
 *   1. paraClassifier — all 5 rules fire correctly
 *   2. inferPhase — the 4 deterministic CODE rules
 *   3. stopConditionEvaluator — deterministic + composite + time-window
 *   4. outcomeEvaluator — full / partial / failed verdicts
 *   5. workflowDispatcher.validateWorkflow — accepts the locked YAML +
 *      rejects malformed inputs
 *
 * Exit code 0 on all pass; 1 on any fail. Designed to run in CI before the
 * master flag flips.
 *
 * Usage:
 *   npx ts-node scripts/smoke-workflow-v1-1.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  classifyPara,
  classifyParaWithRule,
  inferPhase,
} from '../packages/api/src/services/loop/paraClassifier';
import {
  StopConditionEvaluator,
  type Predicate,
} from '../packages/api/src/services/loop/stopConditionEvaluator';
import { OutcomeEvaluator } from '../packages/api/src/services/loop/outcomeEvaluator';
import {
  validateWorkflow,
  WorkflowValidationError,
} from '../packages/api/src/services/loop/workflowDispatcher';
import { computeNextRun } from '../packages/api/src/services/loop/workflowScheduler';
import {
  synthesizeWorkflow,
  inferCategory,
  type Category,
} from '../packages/api/src/services/loop/workflowSynthesizer';
import { MockStepExecutor } from '../packages/api/src/services/loop/mockStepExecutor';

const failures: string[] = [];
let okCount = 0;
const ok = (msg: string) => { okCount += 1; console.log(`  ✓ ${msg}`); };
const fail = (msg: string) => { failures.push(msg); console.log(`  ✗ ${msg}`); };
const assertEq = <T>(actual: T, expected: T, label: string) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) ok(label);
  else fail(`${label} → got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
};

// ─── 1. paraClassifier ────────────────────────────────────────────

console.log('1. paraClassifier — 5 rules');
assertEq(
  classifyParaWithRule({ yaml_default_kind: 'resource' }).rule, 1,
  'Rule 1 — yaml override wins',
);
assertEq(
  classifyParaWithRule({ yaml_area_slug: 'vietnam-ev' }).para_kind, 'area',
  'Rule 2 — yaml area_slug declared → area',
);
assertEq(
  classifyParaWithRule({ is_repeat_buyer_in_area: true, inferred_area_slug: 'vn-ev' }).para_kind, 'project',
  'Rule 3 — repeat buyer → project linked to area',
);
assertEq(
  classifyParaWithRule({ output_artifact_kinds: ['template', 'tone-template'] }).para_kind, 'resource',
  'Rule 4 — all outputs match resource signals → resource',
);
assertEq(
  classifyParaWithRule({}).para_kind, 'project',
  'Rule 5 — default → project',
);

// ─── 2. inferPhase ───────────────────────────────────────────────

console.log('2. inferPhase — CODE auto-classifier');
assertEq(
  inferPhase({ step_id: 's1', depends_on: [], dependents: ['s2'] }), 'capture',
  'no upstream → capture',
);
assertEq(
  inferPhase({ step_id: 's4', depends_on: ['s3'], dependents: [] }), 'express',
  'no downstream → express',
);
assertEq(
  inferPhase({
    step_id: 's3', depends_on: ['s2'], dependents: ['s4'],
    output_schema_keys: ['report_md', 'diagram_mermaid'],
  }), 'distill',
  'distill signals → distill',
);
assertEq(
  inferPhase({ step_id: 's2', depends_on: ['s1'], dependents: ['s3'] }), 'organize',
  'middle without distill signal → organize',
);

// ─── 3. stopConditionEvaluator ───────────────────────────────────

console.log('3. stopConditionEvaluator — predicates');

const stubPool = { query: async () => ({ rowCount: 0, rows: [] }) } as never;
const stubLog = { warn: () => undefined, error: () => undefined, info: () => undefined } as never;
const sce = new StopConditionEvaluator({ pool: stubPool, logger: stubLog });

(async () => {
  const det: Predicate = {
    type: 'deterministic',
    expr: {
      kind: 'compare', op: '>=',
      left: { kind: 'var', name: 'x' },
      right: { kind: 'literal', value: 5 },
    },
  };
  assertEq((await sce.evaluate(det, { vars: { x: 7 } })).satisfied, true, 'deterministic x>=5 with x=7');
  assertEq((await sce.evaluate(det, { vars: { x: 3 } })).satisfied, false, 'deterministic x>=5 with x=3');

  const tw: Predicate = { type: 'time-window', start_ts_ms: 1000, end_ts_ms: 2000 };
  assertEq((await sce.evaluate(tw, { vars: {}, now_ms: 1500 })).satisfied, true, 'time-window inside');
  assertEq((await sce.evaluate(tw, { vars: {}, now_ms: 2500 })).satisfied, false, 'time-window after');

  const composite: Predicate = {
    type: 'composite', op: 'AND',
    children: [det, tw],
  };
  assertEq(
    (await sce.evaluate(composite, { vars: { x: 7 }, now_ms: 1500 })).satisfied, true,
    'composite AND both true',
  );

  // ─── 4. outcomeEvaluator ────────────────────────────────────────
  console.log('4. outcomeEvaluator — verdicts');
  const oe = new OutcomeEvaluator(sce, stubLog);
  const decision_full = await oe.decide({
    predicate: det, ctx: { vars: { x: 7 } },
    steps_total: 4, steps_completed: 4, attestation_hex: 'deadbeef',
  });
  assertEq(decision_full.verdict, 'full', 'outcome full when predicate satisfied');
  assertEq(decision_full.pay_bps, 10000, 'pay_bps=10000 on full');

  const decision_partial = await oe.decide({
    predicate: det, ctx: { vars: { x: 3 } },
    steps_total: 4, steps_completed: 2, attestation_hex: 'cafe',
  });
  assertEq(decision_partial.verdict, 'partial', 'outcome partial when predicate fails but progress');
  assertEq(decision_partial.pay_bps, 5000, 'pay_bps proportional to steps');

  // ─── 5. workflowDispatcher.validateWorkflow ─────────────────────
  console.log('5. validateWorkflow — accepts locked YAML, rejects malformed');
  // Try to load the worked-example YAML (best-effort YAML parse via JSON).
  try {
    const yamlPath = path.join(process.cwd(), 'examples/workflows/research-then-campaign-second-brain.yml');
    fs.statSync(yamlPath);
    ok('worked-example YAML exists at canonical path');
  } catch {
    fail('worked-example YAML missing');
  }

  // Manual fixture (matches worked-example shape, no YAML parser needed).
  const fixture = {
    version: 'v1.1', name: 'fixture',
    steps: [
      { id: 'a', capability: 'research', depends_on: [] },
      { id: 'b', capability: 'organize', depends_on: ['a'] },
      { id: 'c', capability: 'distill', depends_on: ['b'], output_schema: { report_md: 'markdown' } },
      { id: 'd', capability: 'express', depends_on: ['c'] },
    ],
  };
  try {
    const wf = validateWorkflow(fixture);
    assertEq(wf.steps.length, 4, 'fixture has 4 steps');
    assertEq(wf.version, 'v1.1', 'version locked v1.1');
  } catch (e) {
    fail(`unexpected throw on valid fixture: ${(e as Error).message}`);
  }

  // Reject: 0 steps
  try {
    validateWorkflow({ version: 'v1.1', name: 'empty', steps: [] });
    fail('should reject empty steps');
  } catch (e) {
    if (e instanceof WorkflowValidationError) ok('rejects empty steps');
    else fail(`wrong error type: ${(e as Error).message}`);
  }

  // ─── 6. workflowScheduler.computeNextRun ─────────────────────────
  console.log('6. workflowScheduler — computeNextRun');
  const now = new Date('2026-06-18T15:00:00.000Z');
  const next = computeNextRun(now, 9 * 60); // 0900 UTC
  const nextDate = new Date(next);
  assertEq(nextDate.getUTCHours(), 9, 'next run at 09:00 UTC');
  assertEq(nextDate.getUTCDate(), 19, 'next run on the 19th (today is 18th @ 15:00)');

  // ─── 7. PRD-S — workflowSynthesizer (6 categories) ───────────────
  console.log('7. workflowSynthesizer — 6 categories pass validateWorkflow');
  const cats: Category[] = ['research', 'writing', 'translation', 'code', 'analysis', 'other'];
  for (const cat of cats) {
    try {
      const synth = synthesizeWorkflow({ description: `mock service for ${cat}`, category: cat });
      validateWorkflow(synth.workflow); // throws if invalid
      assertEq(synth.inferred_category, cat, `${cat} template valid + tags inferred_category`);
    } catch (e) {
      fail(`${cat} synth: ${(e as Error).message}`);
    }
  }

  // ─── 8. PRD-S — inferCategory keyword scoring ────────────────────
  console.log('8. inferCategory — keyword scoring');
  assertEq(inferCategory('I write twitter threads about crypto'), 'writing',
    'inferCategory writes/twitter → writing');
  assertEq(inferCategory('research the EV market and analyze trends'), 'research',
    'inferCategory research/analyze → research');

  // ─── 9. PRD-S — MockStepExecutor end-to-end ───────────────────────
  console.log('9. MockStepExecutor — round-trips a 3-step writing workflow');
  const exec = new MockStepExecutor(0); // 0ms delay for CI speed
  const synth = synthesizeWorkflow({ description: 'I write social posts', category: 'writing' });
  let allOk = true;
  let lastExpressOutput: Record<string, unknown> | null = null;
  for (const s of synth.workflow.steps) {
    const out = await exec.execute({
      step: s,
      phase: s.phase ?? 'organize',
      resolved_inputs: { request: 'EV adoption Vietnam' },
      agent_id: 'test-agent', buyer_addr: 'test-buyer', job_id: 'runnow-x',
      warm_context: { agent_general: [], per_buyer: [] },
    });
    if (!out.attestation_hex || !out.output) { allOk = false; break; }
    if ((s.phase ?? 'organize') === 'express') lastExpressOutput = out.output;
  }
  assertEq(allOk, true, 'every step produced output + attestation_hex');
  assertEq(typeof lastExpressOutput?.content_pieces !== 'undefined' || typeof lastExpressOutput?.final_output !== 'undefined', true,
    'express step output has content_pieces or final_output');

  // ─── 10. PRD-X1 — OpenXMemWalMirror gating ────────────────────────
  // Unit-style assertion: the factory returns the no-op when the flag is
  // off OR the env is incomplete; returns a live OpenXMemWalMirror instance
  // when both flag + env are present. No network required.
  console.log('10. PRD-X1 — OpenXMemWalMirror flag gating');
  const { getOpenXMemWalMirror, _resetOpenXMemWalMirror, OpenXMemWalMirror } =
    await import('../packages/api/src/services/memwalMirror');

  // (a) Flag off → noop singleton; remember() resolves to null without throwing.
  _resetOpenXMemWalMirror();
  delete process.env.FEATURE_LOOP_MIRROR_LIVE;
  const noopMirror = getOpenXMemWalMirror();
  const noopRes = await noopMirror.remember({ namespace: 'cog-l4-test', text: 'x' });
  assertEq(noopRes, null, 'flag off → mirror returns null (legacy noop)');

  // (b) Flag on but env incomplete → still noop (defensive).
  _resetOpenXMemWalMirror();
  process.env.FEATURE_LOOP_MIRROR_LIVE = 'true';
  delete process.env.OPENX_OPERATOR_MEMWAL_ACCOUNT_ID;
  delete process.env.OPENX_OPERATOR_WALLET_ADDRESS;
  const stillNoop = getOpenXMemWalMirror();
  assertEq(
    !(stillNoop instanceof OpenXMemWalMirror),
    true,
    'flag on + env missing → falls back to noop',
  );

  // (c) Flag on + env present → real OpenXMemWalMirror instance returned.
  _resetOpenXMemWalMirror();
  process.env.FEATURE_LOOP_MIRROR_LIVE = 'true';
  process.env.OPENX_OPERATOR_MEMWAL_ACCOUNT_ID = '0xfakeaccount';
  process.env.OPENX_OPERATOR_WALLET_ADDRESS = '0xfakewallet';
  process.env.OPENX_MEMWAL_DELEGATE_PRIVATE_KEYS = 'fakeprivkey1';
  const live = getOpenXMemWalMirror();
  assertEq(
    live instanceof OpenXMemWalMirror,
    true,
    'flag on + env complete → real OpenXMemWalMirror instance',
  );

  // Cleanup — leave the suite in a clean env state for downstream runners.
  _resetOpenXMemWalMirror();
  delete process.env.FEATURE_LOOP_MIRROR_LIVE;
  delete process.env.OPENX_OPERATOR_MEMWAL_ACCOUNT_ID;
  delete process.env.OPENX_OPERATOR_WALLET_ADDRESS;
  delete process.env.OPENX_MEMWAL_DELEGATE_PRIVATE_KEYS;

  // ─── Summary ──────────────────────────────────────────────────────
  console.log('');
  if (failures.length === 0) {
    console.log(`✓ smoke-workflow-v1-1: all ${okCount} assertions passed`);
    process.exit(0);
  } else {
    console.error(`✗ smoke-workflow-v1-1: ${failures.length} failure(s):`);
    for (const f of failures) console.error(`    - ${f}`);
    process.exit(1);
  }
})().catch((e: Error) => {
  console.error('smoke crashed:', e.message);
  process.exit(2);
});
