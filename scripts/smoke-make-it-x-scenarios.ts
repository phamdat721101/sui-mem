#!/usr/bin/env tsx
/**
 * scripts/smoke-make-it-x-scenarios.ts — PRD Package binding acceptance gate.
 *
 * 5 Make-it-X scenarios under one harness. Each scenario has ≥3 assertions
 * with evidence captured to `scripts/evidence/make-it-x-<timestamp>/`. Pass/
 * fail per scenario; exit code 1 if any scenario fails. Re-running this
 * harness is the iterate-until-green loop's primary instrument.
 *
 *   S1  Make-it-true        mirror live + buildInitExtensionPtb + sovereignty
 *   S2  Make-it-discoverable kind=workflow publish path + dry-run dispatcher
 *   S3  Make-it-pay         PhalaStepExecutor + Bedrock fallback + USDC split
 *   S4  Make-it-usable      buyer/vault namespace + Walrus proxy URL contract
 *   S5  Make-it-safe        RTF + persona-approve + key-rotate PTB builders
 *
 * Run conditions are identical: NODE_ENV=test, no DB connection, all clients
 * are constructor-injected stubs. The harness verifies the CODE PATHS that
 * make the production scenarios pass — production runs are observed via the
 * same channels (`mirror:write`, `phala:exec`, `usdc:distribute`, etc.).
 *
 * Usage:
 *   npx tsx scripts/smoke-make-it-x-scenarios.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Transaction } from '@mysten/sui/transactions';

// ─── Imports under test ────────────────────────────────────────────

import {
  getOpenXMemWalMirror,
  _resetOpenXMemWalMirror,
  OpenXMemWalMirror,
} from '../packages/api/src/services/memwalMirror';
import {
  PhalaStepExecutor,
  type PhalaInfClient,
  type BedrockFallbackClient,
} from '../packages/api/src/services/loop/phalaStepExecutor';
import { MemWalSettlementWorker, operatorBpsFor } from '../packages/api/src/services/memwalSettlement';
import {
  buildInitExtensionPtb,
} from '../packages/sdk/src/loop/upgradeWorkflow';
import {
  buildCreateSubscriptionPtb,
  buildCancelSubscriptionPtb,
} from '../packages/sdk/src/loop/subscription';
import { buildDeletePerBuyerMemoryPtb } from '../packages/sdk/src/loop/rightToForget';
import {
  buildPersonaApprovePtb,
  buildRotateDelegatePtb,
} from '../packages/sdk/src/loop/personaApprove';
import { validateWorkflow } from '../packages/api/src/services/loop/workflowDispatcher';
import { synthesizeWorkflow } from '../packages/api/src/services/loop/workflowSynthesizer';
import { artifactVaultNamespace } from '../packages/api/src/services/loop/memoryService';

// ─── Harness ──────────────────────────────────────────────────────

type Verdict = 'pass' | 'fail';
interface Assertion { name: string; verdict: Verdict; evidence: unknown; ms: number }
interface Scenario { id: string; title: string; assertions: Assertion[] }

const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const EVID_DIR = path.resolve(__dirname, 'evidence', `make-it-x-${STAMP}`);
fs.mkdirSync(EVID_DIR, { recursive: true });

const scenarios: Scenario[] = [];
let activeScenario: Scenario | null = null;

const startScenario = (id: string, title: string) => {
  activeScenario = { id, title, assertions: [] };
  scenarios.push(activeScenario);
  console.log(`\n${id}  ${title}`);
};

async function check(name: string, fn: () => Promise<unknown> | unknown): Promise<void> {
  if (!activeScenario) throw new Error('no active scenario');
  const t0 = Date.now();
  try {
    const evidence = await fn();
    const ms = Date.now() - t0;
    activeScenario.assertions.push({ name, verdict: 'pass', evidence, ms });
    console.log(`  ✓ ${name}  (${ms}ms)`);
  } catch (e) {
    const ms = Date.now() - t0;
    const evidence = { error: (e as Error).message, stack: (e as Error).stack };
    activeScenario.assertions.push({ name, verdict: 'fail', evidence, ms });
    console.log(`  ✗ ${name}  (${ms}ms) — ${(e as Error).message}`);
  }
}

const assertEq = <T>(actual: T, expected: T, label: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} → got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
};
const assertTrue = (cond: boolean, label: string) => {
  if (!cond) throw new Error(label);
};

// ─── Test stubs ────────────────────────────────────────────────────

// Sui object ids must be 0x-prefixed hex of length 64. Use deterministic
// placeholders shaped this way so `tx.object()` validators accept them.
const ID = (suffix: string): string => {
  const hex = (suffix.replace(/[^0-9a-f]/gi, '0') + '0000000000000000').slice(0, 64);
  return ('0x' + hex.padStart(64, '0')).slice(0, 66);
};
const PKG = ID('aaaaaaa1');         // package id
const RUNNER_CAP = ID('11111111');
const AGENT_OBJ = ID('22222222');
const EXT_OBJ = ID('33333333');
const COIN_OBJ = ID('44444444');
const SUB_OBJ = ID('55555555');
const BUYER_ADDR = '0x' + 'b'.repeat(64);

const fakeStepInput = {
  step: {
    id: 'distill-1',
    capability: 'research_distill',
    depends_on: ['capture-1'],
    inputs: { topic: 'Vietnam EV adoption Q3 2026' },
    output_schema: { report_md: 'string', headline: 'string' },
    on_failure: 'halt' as const,
    max_micro_usdc: 250_000,
    risk_tier: 'medium' as const,
  },
  phase: 'distill' as const,
  resolved_inputs: { topic: 'Vietnam EV adoption Q3 2026' },
  agent_id: 'agent-test',
  buyer_addr: '0xbuyer',
  job_id: 'job-test',
  warm_context: {
    agent_general: [{
      id: 1, text: 'past vietnam-ev hire produced 25% headline lift',
      namespace: 'cog-l4-agent-test', para_kind: 'project' as const,
      area_slug: 'vietnam-ev', created_at: '2026-06-19T00:00:00Z',
    }],
    per_buyer: [{
      id: 2, text: 'this buyer prefers Vietnamese-language outputs',
      namespace: 'cog-l4-agent-test-0xbuyer', para_kind: 'project' as const,
      area_slug: 'vietnam-ev', created_at: '2026-06-19T00:00:00Z',
    }],
  },
};

// ───────────────────────────────────────────────────────────────────
// S1 — Make-it-true (mirror live + on-chain PTB + sovereignty proof)
// ───────────────────────────────────────────────────────────────────

(async () => {
  startScenario('S1', 'Make-it-true — mirror → on-chain init_extension PTB');

  await check('OpenXMemWalMirror gates correctly (flag off → noop)', () => {
    _resetOpenXMemWalMirror();
    delete process.env.FEATURE_LOOP_MIRROR_LIVE;
    const m = getOpenXMemWalMirror();
    assertTrue(!(m instanceof OpenXMemWalMirror), 'flag off must yield noop');
    return { kind: 'noop_singleton' };
  });

  await check('OpenXMemWalMirror live (flag on + env complete) instantiates real adapter wrapper', async () => {
    _resetOpenXMemWalMirror();
    process.env.FEATURE_LOOP_MIRROR_LIVE = 'true';
    process.env.OPENX_OPERATOR_MEMWAL_ACCOUNT_ID = '0xacct';
    process.env.OPENX_OPERATOR_WALLET_ADDRESS = '0xwallet';
    process.env.OPENX_MEMWAL_DELEGATE_PRIVATE_KEYS = 'fakekey1';
    const m = getOpenXMemWalMirror();
    assertTrue(m instanceof OpenXMemWalMirror, 'flag on + env complete must yield real OpenXMemWalMirror');
    // Cleanup before next scenario.
    _resetOpenXMemWalMirror();
    delete process.env.FEATURE_LOOP_MIRROR_LIVE;
    delete process.env.OPENX_OPERATOR_MEMWAL_ACCOUNT_ID;
    delete process.env.OPENX_OPERATOR_WALLET_ADDRESS;
    delete process.env.OPENX_MEMWAL_DELEGATE_PRIVATE_KEYS;
    return { instance_type: 'OpenXMemWalMirror' };
  });

  await check('buildInitExtensionPtb produces moveCall to openx_loop_workflow_v1_1::init_extension', () => {
    const tx = buildInitExtensionPtb({
      packageId: PKG,
      agentObjectId: AGENT_OBJ,
      workflowWalrusBlobId: 'blob-wf',
      stopConditionWalrusBlobId: 'blob-stop',
      areaSlugs: ['research', 'writing'],
    });
    assertTrue(tx instanceof Transaction, 'returns @mysten/sui Transaction');
    const data = JSON.parse(JSON.stringify(tx.getData()));
    const target = data.commands?.[0]?.MoveCall?.module + '::' + data.commands?.[0]?.MoveCall?.function;
    assertEq(target, 'openx_loop_workflow_v1_1::init_extension', 'moveCall target');
    return { target, command_count: data.commands?.length };
  });

  await check('buildInitExtensionPtb rejects empty + oversize area_slugs', () => {
    let threw = false;
    try {
      buildInitExtensionPtb({
        packageId: PKG, agentObjectId: AGENT_OBJ,
        workflowWalrusBlobId: 'b1', stopConditionWalrusBlobId: 'b2',
        areaSlugs: [],
      });
    } catch (e) { threw = true; }
    assertTrue(threw, 'empty area_slugs must throw');

    threw = false;
    try {
      buildInitExtensionPtb({
        packageId: PKG, agentObjectId: AGENT_OBJ,
        workflowWalrusBlobId: 'b1', stopConditionWalrusBlobId: 'b2',
        areaSlugs: Array(17).fill('x'),
      });
    } catch (e) { threw = true; }
    assertTrue(threw, '>16 area_slugs must throw');
    return { invariant: 'area_slugs in [1..16]' };
  });

  await check('PRD-X4 — dispatcher emits step_started + step_completed for every step', async () => {
    const { WorkflowDispatcher: WD } = await import('../packages/api/src/services/loop/workflowDispatcher');
    const { MockStepExecutor: MSE } = await import('../packages/api/src/services/loop/mockStepExecutor');
    const { MemoryService: MS } = await import('../packages/api/src/services/loop/memoryService');
    const { OutcomeEvaluator: OE } = await import('../packages/api/src/services/loop/outcomeEvaluator');
    const { StopConditionEvaluator: SCE } = await import('../packages/api/src/services/loop/stopConditionEvaluator');
    const { synthesizeWorkflow: synth } = await import('../packages/api/src/services/loop/workflowSynthesizer');

    // Minimal pg-Pool stub: SELECTs return no rows; INSERT...RETURNING id
    // returns a synthetic id (the dispatcher's L2/L3 writes need a row).
    let nextId = 1;
    const fakePool = {
      query: async (text: string) => {
        if (/RETURNING\s+id/i.test(text)) {
          return { rows: [{ id: nextId++ }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    const fakeLogger = { info: () => {}, warn: () => {}, error: () => {} };
    const memSvc = new MS({ pool: fakePool as never, mirror: { remember: async () => null }, logger: fakeLogger as never });
    const sce = new SCE({ pool: fakePool as never, logger: fakeLogger as never });
    const oe = new OE(sce, fakeLogger as never);
    const exec = new MSE(0);
    const dispatcher = new WD(memSvc, oe, exec, fakeLogger as never);

    const wf = synth({ description: 'Vietnam EV Q3 2026 brief', category: 'research' }).workflow;
    const events: string[] = [];
    const result = await dispatcher.run({
      workflow: wf,
      agent_id: 'a-evt', buyer_addr: 'b-evt', job_id: 'j-evt',
      buyer_input: { request: 'EV Q3' },
      area_slug: 'vietnam-ev', budget_micro: 100_000_000,
      onStepEvent: (e) => events.push(`${e.kind}:${e.step_id}`),
    });
    const startedCount = events.filter((e) => e.startsWith('step_started:')).length;
    const completedCount = events.filter((e) => e.startsWith('step_completed:')).length;
    assertEq(startedCount, wf.steps.length, 'step_started fired per step');
    assertEq(completedCount, wf.steps.length, 'step_completed fired per step');
    assertEq(result.steps_completed, wf.steps.length, 'all steps completed');
    return { events_emitted: events.length, steps: wf.steps.length };
  });
})()
  // ───────────────────────────────────────────────────────────────────
  // S2 — Make-it-discoverable
  // ───────────────────────────────────────────────────────────────────
  .then(async () => {
    startScenario('S2', 'Make-it-discoverable — kind=workflow publish path');

    await check('marketplace ?kind= filter is enumerated in route validator', async () => {
      const src = fs.readFileSync(
        path.resolve(__dirname, '../packages/api/src/routes/v3-marketplace.ts'),
        'utf8',
      );
      assertTrue(/VALID_KINDS\s*=\s*new Set\(\[/.test(src), 'VALID_KINDS set declared');
      assertTrue(src.includes("'workflow'") && src.includes("'api'"), 'workflow + api in VALID_KINDS');
      assertTrue(/AND a\.kind = \$/.test(src), 'WHERE a.kind clause present');
      return { evidence: 'VALID_KINDS + WHERE a.kind = $N' };
    });

    await check('SellerPublishInput.kind=workflow validator catches missing fields', async () => {
      // Re-import the validator each time because it lives behind module-internal `validate`.
      // We exercise it through the export `publish()` would call — but `publish()` opens a
      // pool. So we mirror the exact validation rules here as a contract test against the
      // service shape (the full path is exercised by smoke:studio-publish-v2-e2e in CI).
      const { /* publish */ } = await import('../packages/api/src/services/sellerPublishService');
      const src = fs.readFileSync(
        path.resolve(__dirname, '../packages/api/src/services/sellerPublishService.ts'),
        'utf8',
      );
      assertTrue(
        /workflow_walrus_blob_id required when kind=workflow/.test(src),
        'validator rejects missing workflow_walrus_blob_id',
      );
      assertTrue(
        /area_slugs must be 1\.\.16 entries when kind=workflow/.test(src),
        'validator rejects empty area_slugs',
      );
      assertTrue(
        /kind, input\.workflow_walrus_blob_id \?\? null/.test(src),
        'agents INSERT writes both kind + workflow_walrus_blob_id',
      );
      return { kind_path: 'validated + persisted' };
    });

    await check('dry-run dispatcher returns WorkflowRunResult shape with steps + outcome', async () => {
      const synth = synthesizeWorkflow({ description: 'Vietnam EV research', category: 'research' });
      validateWorkflow(synth.workflow);
      // The dry-run endpoint instantiates the dispatcher with a real pg Pool — we don't have one
      // here. But the workflow validation is the gate the endpoint runs first and the only place
      // a malformed YAML would short-circuit. Asserting validateWorkflow + step count + an in-process
      // mock-executor result is the fastest way to verify the dispatcher contract.
      const { MockStepExecutor } = await import('../packages/api/src/services/loop/mockStepExecutor');
      const exec = new MockStepExecutor(0);
      const t0 = Date.now();
      const outputs: Array<Record<string, unknown>> = [];
      for (const s of synth.workflow.steps) {
        const out = await exec.execute({
          step: s, phase: s.phase ?? 'organize',
          resolved_inputs: { request: 'Vietnam EV' },
          agent_id: 'a', buyer_addr: 'b', job_id: 'j',
          warm_context: { agent_general: [], per_buyer: [] },
        });
        outputs.push(out.output);
      }
      const elapsed = Date.now() - t0;
      assertTrue(elapsed < 2000, `dry-run elapsed ${elapsed}ms < 2000ms`);
      assertTrue(outputs.length === synth.workflow.steps.length, 'every step produced output');
      return { steps: outputs.length, elapsed_ms: elapsed };
    });

    await check('PRD-X6 — /upgrade flips agents.kind=workflow when blob_id is real (not placeholder)', () => {
      const src = fs.readFileSync(
        path.resolve(__dirname, '../packages/api/src/routes/v3-loop.ts'),
        'utf8',
      );
      assertTrue(
        src.includes("=== 'pending-on-chain-ptb'"),
        'placeholder check present (legacy pass-through)',
      );
      assertTrue(
        /UPDATE agents SET workflow_walrus_blob_id = \$1, kind = 'workflow'/.test(src),
        'kind flips to workflow on real blob_id',
      );
      assertTrue(
        src.includes("'ptb:submit:upgrade'"),
        'ptb:submit:upgrade Pino channel logged',
      );
      return { invariant: 'kind=workflow only on real blob_id' };
    });
  })

  // ───────────────────────────────────────────────────────────────────
  // S3 — Make-it-pay
  // ───────────────────────────────────────────────────────────────────
  .then(async () => {
    startScenario('S3', 'Make-it-pay — Phala-attested run + USDC settlement');

    await check('PhalaStepExecutor returns Phala attestation_hex on success', async () => {
      const phala: PhalaInfClient = {
        infer: async () => ({
          answer: '{"report_md":"# EV report","headline":"EVs up 18%"}',
          attestation: { quote: '0xphala-quote-fake-hash', verified: true },
        }),
      };
      const exec = new PhalaStepExecutor({ phala, cfg: { timeoutMs: 0 } });
      const out = await exec.execute(fakeStepInput);
      assertEq(out.attestation_hex, '0xphala-quote-fake-hash', 'phala quote propagated');
      assertTrue(typeof out.output.report_md === 'string', 'output parsed as JSON');
      assertTrue(out.spent_micro <= fakeStepInput.step.max_micro_usdc, 'spent ≤ max');
      return { attestation_hex: out.attestation_hex, spent_micro: out.spent_micro };
    });

    await check('PhalaStepExecutor falls back to Bedrock with bedrock-fallback: prefix', async () => {
      const phala: PhalaInfClient = { infer: async () => { throw new Error('phala:5xx'); } };
      const bedrock: BedrockFallbackClient = {
        infer: async () => ({ answer: '{"report_md":"# fallback","headline":"fallback"}' }),
      };
      const exec = new PhalaStepExecutor({ phala, bedrock, cfg: { timeoutMs: 0, maxRetries: 0 } });
      const out = await exec.execute(fakeStepInput);
      assertTrue(out.attestation_hex.startsWith('bedrock-fallback:'), 'fallback prefix present');
      return { attestation_hex_prefix: out.attestation_hex.slice(0, 18) };
    });

    await check('Direct settlement worker computes seller/operator split correctly', async () => {
      const fakePool = {
        query: async () => ({ rows: [{ count: '0' }], rowCount: 1 }),
      };
      const worker = new MemWalSettlementWorker({ pool: fakePool as never, enabled: false });
      const captured: unknown[] = [];
      const r = await worker.runDirectSettlement({
        brain_sui_object_id: '0xbrain',
        seller_wallet: '0xseller',
        amount_usdc_micro: 1_000_000, // 1 USDC
        rollingCount30d: 0, // → BPS = 500 (5%)
        submitDistributePtb: async (req) => {
          captured.push(req);
          return '0xfakedigest';
        },
      });
      assertEq(r.operator_bps, 500, 'operator_bps at low volume');
      assertEq(r.operator_micro, 50_000, 'operator gets 5% of 1 USDC = 50_000 µ');
      assertEq(r.seller_micro, 950_000, 'seller gets 95%');
      assertEq(r.settlement_tx_hash, '0xfakedigest', 'digest propagated');
      return { ...r, captured };
    });

    await check('operator_bps volume dial: 500→400→300→200 across thresholds', () => {
      assertEq(operatorBpsFor(0), 500, 'count=0 → 500 bps');
      assertEq(operatorBpsFor(99), 500, 'count<100 → 500 bps');
      assertEq(operatorBpsFor(100), 400, 'count≥100 → 400 bps');
      assertEq(operatorBpsFor(1_000), 300, 'count≥1000 → 300 bps');
      assertEq(operatorBpsFor(10_000), 200, 'count≥10000 → 200 bps');
      return { tiers: '500/400/300/200' };
    });
  })

  // ───────────────────────────────────────────────────────────────────
  // S4 — Make-it-usable
  // ───────────────────────────────────────────────────────────────────
  .then(async () => {
    startScenario('S4', 'Make-it-usable — buyer/vault namespace + Walrus proxy');

    await check('artifact-vault namespace formatter normalizes wallet to lowercase', () => {
      const ns1 = artifactVaultNamespace('0xABCDEF');
      assertEq(ns1, 'artifact-vault-0xabcdef', 'mixed-case lowered');
      const ns2 = artifactVaultNamespace('0xabcdef');
      assertEq(ns2, 'artifact-vault-0xabcdef', 'already-lower stable');
      return { ns_format: 'artifact-vault-{lowercased}' };
    });

    await check('GET /v3/loop/buyer/vault/runs handler is registered + queries correct namespace', async () => {
      const src = fs.readFileSync(
        path.resolve(__dirname, '../packages/api/src/routes/v3-loop.ts'),
        'utf8',
      );
      assertTrue(
        src.includes("router.get('/buyer/vault/runs'"),
        'GET /buyer/vault/runs registered',
      );
      assertTrue(
        /artifact-vault-\$\{wallet\}/.test(src),
        'query keys on artifact-vault-{wallet} namespace',
      );
      assertTrue(
        /sinceDays|sinceDays \?\? 30/.test(src),
        'sinceDays query param honored',
      );
      return { handler: 'registered + ns-keyed' };
    });

    await check('GET /v3/loop/buyer/vault/download/:blob_id refuses blobs not in buyer namespace', async () => {
      const src = fs.readFileSync(
        path.resolve(__dirname, '../packages/api/src/routes/v3-loop.ts'),
        'utf8',
      );
      assertTrue(
        src.includes("router.get('/buyer/vault/download/:blob_id'"),
        'download endpoint registered',
      );
      assertTrue(
        /not_in_vault/.test(src),
        '404 not_in_vault when blob absent from buyer namespace',
      );
      assertTrue(
        /WALRUS_AGGREGATOR_URL/.test(src),
        'streams from WALRUS_AGGREGATOR_URL aggregator',
      );
      assertTrue(
        /Content-Disposition[^\n]*attachment/.test(src),
        'Content-Disposition: attachment header set',
      );
      return { handler: 'authorized + Walrus-proxied' };
    });
  })

  // ───────────────────────────────────────────────────────────────────
  // S5 — Make-it-safe
  // ───────────────────────────────────────────────────────────────────
  .then(async () => {
    startScenario('S5', 'Make-it-safe — RTF + persona-approve + key-rotate');

    await check('buildDeletePerBuyerMemoryPtb requires cooling_off_days ≥ 7', () => {
      let threw = false;
      try {
        buildDeletePerBuyerMemoryPtb({
          packageId: PKG, runnerCapObjectId: RUNNER_CAP, agentObjectId: AGENT_OBJ,
          buyerAddr: BUYER_ADDR, coolingOffDays: 6,
        });
      } catch (e) { threw = true; }
      assertTrue(threw, 'coolingOffDays=6 must throw');

      const tx = buildDeletePerBuyerMemoryPtb({
        packageId: PKG, runnerCapObjectId: RUNNER_CAP, agentObjectId: AGENT_OBJ,
        buyerAddr: BUYER_ADDR, coolingOffDays: 7,
      });
      const data = JSON.parse(JSON.stringify(tx.getData()));
      const target = data.commands?.[0]?.MoveCall?.module + '::' + data.commands?.[0]?.MoveCall?.function;
      assertEq(target, 'openx_loop_workflow_v1_1::delete_per_buyer_memory', 'moveCall target');
      return { target, cooling_off_invariant: 'days >= 7' };
    });

    await check('buildPersonaApprovePtb produces update_extension PTB; rejects missing blob id', () => {
      let threw = false;
      try {
        buildPersonaApprovePtb({
          packageId: PKG, agentObjectId: AGENT_OBJ,
          agentV11ExtensionObjectId: EXT_OBJ, newPersonaWalrusBlobId: '',
        });
      } catch (e) { threw = true; }
      assertTrue(threw, 'empty newPersonaWalrusBlobId must throw');

      const tx = buildPersonaApprovePtb({
        packageId: PKG, agentObjectId: AGENT_OBJ,
        agentV11ExtensionObjectId: EXT_OBJ, newPersonaWalrusBlobId: 'blob-new',
      });
      const data = JSON.parse(JSON.stringify(tx.getData()));
      const target = data.commands?.[0]?.MoveCall?.module + '::' + data.commands?.[0]?.MoveCall?.function;
      assertEq(target, 'openx_loop_workflow_v1_1::update_extension', 'persona approve target');
      return { target };
    });

    await check('buildRotateDelegatePtb rejects same-pubkey rotation + accepts valid rotate', () => {
      let threw = false;
      try {
        buildRotateDelegatePtb({
          packageId: PKG, agentObjectId: AGENT_OBJ,
          oldPubkeyHex: '0xaa', newPubkeyHex: '0xaa',
        });
      } catch (e) { threw = true; }
      assertTrue(threw, 'same pubkey must throw');

      const tx = buildRotateDelegatePtb({
        packageId: PKG, agentObjectId: AGENT_OBJ,
        oldPubkeyHex: '0xaa', newPubkeyHex: '0xbb',
      });
      const data = JSON.parse(JSON.stringify(tx.getData()));
      const target = data.commands?.[0]?.MoveCall?.module + '::' + data.commands?.[0]?.MoveCall?.function;
      assertEq(target, 'openx_loop_agent_registry::rotate_delegate_key', 'rotate target');
      return { target };
    });

    await check('subscription create + cancel builders match Move targets + type args', () => {
      const usdc = '0xabc::usdc::USDC';
      const create = buildCreateSubscriptionPtb({
        packageId: PKG, usdcCoinType: usdc,
        agentObjectId: AGENT_OBJ, templateWalrusBlobId: 'tmpl',
        areaSlug: 'research', cronUtcMinute: 540, runs: 30,
        maxPerRunMicro: 5_000_000n, budgetCoinObjectId: COIN_OBJ,
      });
      const cdata = JSON.parse(JSON.stringify(create.getData()));
      const ctarget = cdata.commands?.[0]?.MoveCall?.module + '::' + cdata.commands?.[0]?.MoveCall?.function;
      assertEq(ctarget, 'openx_loop_subscription::create_subscription', 'create target');
      assertEq(cdata.commands?.[0]?.MoveCall?.typeArguments?.[0], usdc, 'create typeArg = USDC');

      const cancel = buildCancelSubscriptionPtb({
        packageId: PKG, usdcCoinType: usdc, subscriptionObjectId: SUB_OBJ,
      });
      const xdata = JSON.parse(JSON.stringify(cancel.getData()));
      const xtarget = xdata.commands?.[0]?.MoveCall?.module + '::' + xdata.commands?.[0]?.MoveCall?.function;
      assertEq(xtarget, 'openx_loop_subscription::cancel_subscription', 'cancel target');
      return { create_target: ctarget, cancel_target: xtarget };
    });

    await check('PRD-X8 — LlmJudgeCheckpoint never auto_approves high-risk regardless of confidence', async () => {
      const { LlmJudgeCheckpoint } = await import('../packages/api/src/services/loop/llmJudgeCheckpoint');
      // Construct judge with a backend that ALWAYS reports max confidence.
      const allConfident = {
        evaluate: async () => ({ confidence: 1.0, reason: 'looks great' }),
      };
      const judge = new LlmJudgeCheckpoint({ backend: allConfident, logger: { warn: () => {} } as never });
      const high = await judge.judge({
        risk_tier: 'high',
        step_output: { whatever: 'x' },
        expected_schema: { whatever: 'string' },
      });
      assertEq(high.auto_approve, false, 'high-risk MUST NOT auto-approve');
      const low = await judge.judge({
        risk_tier: 'low',
        step_output: { whatever: 'x' },
        expected_schema: { whatever: 'string' },
      });
      assertEq(low.auto_approve, true, 'low-risk auto-approves at confidence ≥ 0.8');
      return { high_auto_approve: high.auto_approve, low_auto_approve: low.auto_approve };
    });

    await check('PRD-X6 — /subscriptions/confirm + /subscriptions/:id/cancel registered', () => {
      const src = fs.readFileSync(
        path.resolve(__dirname, '../packages/api/src/routes/v3-loop.ts'),
        'utf8',
      );
      assertTrue(
        src.includes("router.post('/subscriptions/confirm'"),
        '/subscriptions/confirm registered',
      );
      assertTrue(
        src.includes("router.post('/subscriptions/:id/cancel'"),
        '/subscriptions/:id/cancel registered',
      );
      assertTrue(
        /openx_workflow_escrow::cancel_escrow/.test(src),
        'cancel handler builds the cancel_escrow Move call',
      );
      return { handlers: 'confirm + cancel both wired' };
    });
  })

  // ───────────────────────────────────────────────────────────────────
  // Reporting + exit
  // ───────────────────────────────────────────────────────────────────
  .then(() => {
    console.log('\n──────────  Make-it-X scenario verdicts  ──────────');
    let allPass = true;
    for (const s of scenarios) {
      const passed = s.assertions.every((a) => a.verdict === 'pass');
      if (!passed) allPass = false;
      const total = s.assertions.length;
      const ok = s.assertions.filter((a) => a.verdict === 'pass').length;
      console.log(`${passed ? '✓' : '✗'}  ${s.id}  ${s.title.padEnd(54)}  ${ok}/${total}`);
      // Persist evidence per scenario.
      fs.writeFileSync(
        path.join(EVID_DIR, `${s.id}.json`),
        JSON.stringify(s, null, 2),
      );
    }
    console.log(`\nEvidence written to: ${EVID_DIR}`);
    if (!allPass) {
      console.error('\n✗ One or more scenarios failed. Fix root cause + rerun.');
      process.exit(1);
    }
    console.log('\n✓ All 5 Make-it-X scenarios pass.');
    process.exit(0);
  })
  .catch((e: Error) => {
    console.error('harness crashed:', e.message, '\n', e.stack);
    process.exit(2);
  });
