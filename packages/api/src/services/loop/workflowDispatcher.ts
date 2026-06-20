/**
 * services/loop/workflowDispatcher.ts — PRD-W2 DAG runtime.
 *
 * Single class that owns one workflow run from YAML-parse to settlement
 * decision. Step execution is delegated to a `StepExecutor` interface
 * (constructor-injected) so tests don't need Phala TEE. Memory writes go
 * through `MemoryService`. Settlement decision goes through `OutcomeEvaluator`.
 *
 * Pipeline per run:
 *   1. validate YAML (V1-V12: ≥1 capture, ≥1 express, no cycles, ≤20 steps)
 *   2. topo-sort (Kahn) → linear plan
 *   3. for each step: read warm context (CAPTURE) or resolve `{{ ... }}` refs,
 *      execute via injected StepExecutor, collect output, log phase event,
 *      bookkeep step result + spent-micro
 *   4. on_failure policy: retry-once / halt / continue-skip
 *   5. after all steps: compute `OutcomeDecision` and let caller settle on chain
 *
 * SOLID:
 *   - SRP: orchestration only. No HTTP, no Sui PTB, no LLM call here.
 *   - DIP: 4 deps (memory, outcome, exec, logger) injected via constructor.
 *   - OCP: a new step kind = a new branch inside the StepExecutor implementation,
 *     not in this dispatcher.
 *
 * Performance:
 *   - O(V+E) toposort; O(V) execution (no parallel — workflow steps may
 *     race conditions on shared escrow). Parallelism in v1.2.
 */

import type { Logger } from 'pino';
import {
  inferPhase,
  type CodePhase,
} from './paraClassifier';
import {
  MemoryService,
} from './memoryService';
import {
  OutcomeEvaluator,
  type OutcomeDecision,
  type OutcomeInput,
} from './outcomeEvaluator';
import type { Predicate } from './stopConditionEvaluator';

// ─── YAML schema — manual validation, no external deps ─────────────

export interface Step {
  id: string;
  capability: string;
  phase?: CodePhase;
  depends_on: string[];
  inputs: Record<string, unknown>;
  output_schema?: Record<string, string>;
  on_failure: 'retry-once' | 'halt' | 'continue-skip';
  max_micro_usdc: number;
  risk_tier: 'low' | 'medium' | 'high';
}

export interface Workflow {
  version: 'v1.1';
  name: string;
  para?: {
    default_kind?: 'project' | 'area' | 'resource';
    area_slug?: string;
  };
  steps: Step[];
  stop_condition?: Predicate;
}

export class WorkflowValidationError extends Error {
  constructor(public readonly field: string, msg: string) {
    super(`workflow:invalid:${field}: ${msg}`);
    this.name = 'WorkflowValidationError';
  }
}

/** Hand-rolled validator. Zero deps. Returns a normalized `Workflow`. */
export function validateWorkflow(raw: unknown): Workflow {
  if (!raw || typeof raw !== 'object') throw new WorkflowValidationError('root', 'not an object');
  const r = raw as Record<string, unknown>;
  if (r.version !== 'v1.1') throw new WorkflowValidationError('version', 'must equal "v1.1"');
  if (typeof r.name !== 'string' || !r.name) throw new WorkflowValidationError('name', 'required string');
  if (!Array.isArray(r.steps) || r.steps.length === 0 || r.steps.length > 20) {
    throw new WorkflowValidationError('steps', '1..20 steps required');
  }
  const phases = new Set(['capture', 'organize', 'distill', 'express']);
  const failures = new Set(['retry-once', 'halt', 'continue-skip']);
  const tiers = new Set(['low', 'medium', 'high']);
  const ids = new Set<string>();
  const steps: Step[] = r.steps.map((rawStep, i) => {
    const s = rawStep as Record<string, unknown>;
    const path = `steps[${i}]`;
    if (typeof s.id !== 'string' || !s.id || s.id.length > 64)
      throw new WorkflowValidationError(`${path}.id`, 'string 1..64');
    if (ids.has(s.id)) throw new WorkflowValidationError(`${path}.id`, `duplicate "${s.id}"`);
    ids.add(s.id);
    if (typeof s.capability !== 'string' || !s.capability)
      throw new WorkflowValidationError(`${path}.capability`, 'required');
    if (s.phase !== undefined && !phases.has(s.phase as string))
      throw new WorkflowValidationError(`${path}.phase`, 'must be capture/organize/distill/express');
    const depends_on = Array.isArray(s.depends_on) ? (s.depends_on as string[]) : [];
    return {
      id: s.id,
      capability: s.capability,
      phase: s.phase as CodePhase | undefined,
      depends_on,
      inputs: (s.inputs as Record<string, unknown>) ?? {},
      output_schema: s.output_schema as Record<string, string> | undefined,
      on_failure: failures.has(s.on_failure as string)
        ? (s.on_failure as Step['on_failure']) : 'halt',
      max_micro_usdc: typeof s.max_micro_usdc === 'number' && s.max_micro_usdc >= 0
        ? Math.floor(s.max_micro_usdc) : 0,
      risk_tier: tiers.has(s.risk_tier as string)
        ? (s.risk_tier as Step['risk_tier']) : 'medium',
    };
  });
  return {
    version: 'v1.1',
    name: r.name,
    para: r.para as Workflow['para'],
    steps,
    stop_condition: r.stop_condition as Predicate | undefined,
  };
}

// ─── Default skeleton (PRD-X — buyer-side self-heal) ─────────────────
//
// When a kind=workflow agent's seller hasn't yet authored a custom YAML
// (very common: seller upgrades, immediately a buyer wants to hire), the
// /run-workflow endpoint falls back to this 2-step skeleton so the buyer
// gets a real result instead of `no_workflow_saved`. Seller can refine
// later via /agent/[id]/workflow editor — latest-wins on cognitive_memories.
//
// SOLID: SRP — one pure factory. Same shape as the publish + upgrade page
// skeletons in the FE; single source of truth lives here so renames stay
// consistent (FE and BE both ship the same shape).
export function defaultWorkflowSkeleton(agent_id: string): Workflow {
  return validateWorkflow({
    version: 'v1.1',
    name: `agent-${agent_id} (default)`,
    para: { default_kind: 'project' },
    steps: [
      {
        id: 'capture-1', capability: 'web_search', depends_on: [],
        inputs: { query: '{{ buyer_input.request }}' },
        output_schema: { findings: 'string[]' },
        on_failure: 'halt', max_micro_usdc: 100_000, risk_tier: 'low',
      },
      {
        id: 'express-1', capability: 'summarize', depends_on: ['capture-1'],
        inputs: { findings: '{{ steps.capture-1.findings }}' },
        output_schema: { final_output: 'string' },
        on_failure: 'halt', max_micro_usdc: 200_000, risk_tier: 'medium',
      },
    ],
  });
}

// ─── Step executor (DIP boundary) ──────────────────────────────────

export interface StepExecutionInput {
  step: Step;
  phase: CodePhase;
  resolved_inputs: Record<string, unknown>;
  agent_id: string;
  buyer_addr: string;
  job_id: string;
  warm_context: Awaited<ReturnType<MemoryService['readWarmContext']>>;
}

export interface StepExecutionOutput {
  output: Record<string, unknown>;
  spent_micro: number;
  attestation_hex: string;
}

export interface StepExecutor {
  execute(input: StepExecutionInput): Promise<StepExecutionOutput>;
}

// ─── Run state ──────────────────────────────────────────────────────

/** PRD-X4 / PRD-X8 — emitted at step boundaries. The SSE route in
 *  routes/v3-loop.ts (deferred) wraps these into text/event-stream;
 *  the smoke harness asserts dispatcher emits them in order. */
export type StepEvent =
  | { kind: 'step_started'; step_id: string; phase: CodePhase }
  | { kind: 'step_completed'; step_id: string; phase: CodePhase; spent_micro: number }
  | { kind: 'step_failed'; step_id: string; phase: CodePhase; reason: string }
  | {
      kind: 'step_judged';
      step_id: string;
      phase: CodePhase;
      risk_tier: 'low' | 'medium' | 'high';
      auto_approve: boolean;
      confidence: number;
      reason: string;
    };

export interface WorkflowRunInput {
  workflow: Workflow;
  agent_id: string;
  buyer_addr: string;
  job_id: string;
  buyer_input: Record<string, unknown>;
  area_slug?: string;
  /** Stop condition (typed Predicate) deserialized from Walrus blob. */
  stop_condition?: Predicate;
  /** Total budget µUSDC (LoopJob.budget_micro). */
  budget_micro: number;
  /** PRD-X4 — optional callback fired at step_started / step_completed /
   *  step_failed / step_judged boundaries. Run-input scope (not constructor)
   *  so different runs can have different listeners (SSE vs none). */
  onStepEvent?: (e: StepEvent) => void;
}

export interface WorkflowRunResult {
  steps_completed: number;
  steps_total: number;
  spent_micro: number;
  per_step: Array<{
    id: string; phase: CodePhase; output: Record<string, unknown>;
    spent_micro: number; status: 'ok' | 'skipped' | 'failed';
  }>;
  outcome: OutcomeDecision | null;
}

// ─── Dispatcher ─────────────────────────────────────────────────────

export class WorkflowDispatcher {
  constructor(
    private readonly memory: MemoryService,
    private readonly outcome: OutcomeEvaluator,
    private readonly executor: StepExecutor,
    private readonly logger: Logger,
    /** PRD-X8 — optional. When present, dispatcher informationally judges
     *  every step's output against `expected_schema`. The judge enforces
     *  the invariant `risk_tier=high → never auto_approve`; downstream
     *  SSE+UI integration uses the verdict to decide pause-for-approval.
     *  Importing the type as a structural shape avoids a hard dep cycle. */
    private readonly judge?: {
      judge(args: {
        risk_tier: 'low' | 'medium' | 'high';
        step_output: Record<string, unknown>;
        expected_schema?: Record<string, string>;
      }): Promise<{ auto_approve: boolean; confidence: number; reason: string }>;
    },
  ) {}

  async run(input: WorkflowRunInput): Promise<WorkflowRunResult> {
    // Validate up front — throws structured errors if YAML is malformed.
    const wf = validateWorkflow(input.workflow);

    // V10 + V11 — at least 1 capture + 1 express step.
    const planned = this.planSteps(wf);
    const phases = new Set(planned.map((p) => p.phase));
    if (!phases.has('capture')) throw new Error('workflow:missing-capture-step');
    if (!phases.has('express')) throw new Error('workflow:missing-express-step');

    // Read warm context once (used by every CAPTURE step; cached for reuse).
    const warm = await this.memory.readWarmContext({
      agent_id: input.agent_id,
      buyer_addr: input.buyer_addr,
      area_slug: input.area_slug,
    });
    this.logger.info(
      { job_id: input.job_id, general_hits: warm.agent_general.length, perBuyer_hits: warm.per_buyer.length },
      'dispatcher:warm_context_loaded',
    );

    const stepOutputs = new Map<string, Record<string, unknown>>();
    const per_step: WorkflowRunResult['per_step'] = [];
    let spent_micro = 0;
    let lastAttestation = '';

    for (const { step, phase } of planned) {
      // Budget gate (T3 mitigation: auto-halt at 0.8 × budget).
      if (spent_micro + step.max_micro_usdc > Math.floor(input.budget_micro * 0.8) + step.max_micro_usdc) {
        if (spent_micro > input.budget_micro * 0.8) {
          this.logger.warn({ job_id: input.job_id, spent_micro, budget: input.budget_micro }, 'dispatcher:budget_halt');
          per_step.push({ id: step.id, phase, output: {}, spent_micro: 0, status: 'skipped' });
          continue;
        }
      }

      const resolved = this.resolveInputs(step.inputs, {
        buyer_input: input.buyer_input,
        steps: Object.fromEntries(stepOutputs),
        memory: { recall: { area: warm } },
      });

      // PRD-X4 — emit step_started before the executor is invoked.
      input.onStepEvent?.({ kind: 'step_started', step_id: step.id, phase });

      const status = await this.executeWithPolicy(step, phase, {
        step,
        phase,
        resolved_inputs: resolved,
        agent_id: input.agent_id,
        buyer_addr: input.buyer_addr,
        job_id: input.job_id,
        warm_context: warm,
      });

      if (status.kind === 'failed') {
        per_step.push({ id: step.id, phase, output: {}, spent_micro: 0, status: 'failed' });
        input.onStepEvent?.({
          kind: 'step_failed', step_id: step.id, phase, reason: 'executor_exhausted_retries',
        });
        if (step.on_failure === 'halt') break;
        continue;
      }

      stepOutputs.set(step.id, status.exec.output);
      spent_micro += status.exec.spent_micro;
      lastAttestation = status.exec.attestation_hex;
      per_step.push({
        id: step.id, phase, output: status.exec.output,
        spent_micro: status.exec.spent_micro, status: 'ok',
      });
      input.onStepEvent?.({
        kind: 'step_completed', step_id: step.id, phase, spent_micro: status.exec.spent_micro,
      });

      // PRD-X8 — optional judge pass. Informational in v1; SSE+UI integration
      // uses the verdict to decide pause-for-approval. The judge enforces
      // the invariant high-risk → never auto_approve internally.
      if (this.judge) {
        try {
          const verdict = await this.judge.judge({
            risk_tier: step.risk_tier,
            step_output: status.exec.output,
            expected_schema: step.output_schema,
          });
          input.onStepEvent?.({
            kind: 'step_judged', step_id: step.id, phase, risk_tier: step.risk_tier,
            ...verdict,
          });
        } catch (e) {
          this.logger.warn(
            { step_id: step.id, err: (e as Error).message },
            'dispatcher:judge_failed_continue',
          );
        }
      }

      // L2 write per step — operator-pool fallback OK.
      await this.memory.writeL2({
        agent_id: input.agent_id, job_id: input.job_id, step_id: step.id,
        text: JSON.stringify({ phase, output: status.exec.output }).slice(0, 4000),
      }).catch((e: Error) =>
        this.logger.warn({ err: e.message }, 'dispatcher:writeL2_failed_continue'));
    }

    // L3 + L4 + L5 post-completion writes (parallel; L4/L5 fail-loud).
    const succeeded = per_step.filter((s) => s.status === 'ok').length;
    if (succeeded > 0) {
      await this.postRunWrites(input, per_step, wf);
    }

    // Outcome evaluation (only when outcome_pricing flag is set on the LoopJob).
    let outcome: OutcomeDecision | null = null;
    if (input.stop_condition) {
      const flat: Record<string, number | string | boolean> = {
        steps_total: planned.length,
        steps_completed: succeeded,
        spent_micro,
      };
      const outcomeInput: OutcomeInput = {
        predicate: input.stop_condition,
        ctx: { vars: flat },
        steps_total: planned.length,
        steps_completed: succeeded,
        attestation_hex: lastAttestation,
      };
      outcome = await this.outcome.decide(outcomeInput);
    }

    return {
      steps_completed: succeeded,
      steps_total: planned.length,
      spent_micro,
      per_step,
      outcome,
    };
  }

  /** Topo sort (Kahn's algorithm) + phase auto-classification. */
  private planSteps(wf: Workflow): Array<{ step: Step; phase: CodePhase }> {
    const indegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    for (const s of wf.steps) {
      indegree.set(s.id, s.depends_on.length);
      for (const d of s.depends_on) {
        const arr = dependents.get(d) ?? [];
        arr.push(s.id);
        dependents.set(d, arr);
      }
    }
    const queue = wf.steps.filter((s) => (indegree.get(s.id) ?? 0) === 0).map((s) => s.id);
    const order: string[] = [];
    while (queue.length > 0) {
      const id = queue.shift()!;
      order.push(id);
      for (const child of dependents.get(id) ?? []) {
        const next = (indegree.get(child) ?? 0) - 1;
        indegree.set(child, next);
        if (next === 0) queue.push(child);
      }
    }
    if (order.length !== wf.steps.length) throw new Error('workflow:has-cycle');

    const stepById = new Map(wf.steps.map((s) => [s.id, s]));
    return order.map((id) => {
      const s = stepById.get(id)!;
      const phase: CodePhase = s.phase ?? inferPhase({
        step_id: id,
        depends_on: s.depends_on,
        dependents: dependents.get(id) ?? [],
        output_schema_keys: s.output_schema ? Object.keys(s.output_schema) : undefined,
      });
      return { step: s, phase };
    });
  }

  /** Mustache-lite: resolves `{{ a.b.c }}` against a context bag. */
  private resolveInputs(
    inputs: Record<string, unknown>,
    ctx: Record<string, unknown>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(inputs)) {
      if (typeof v === 'string') {
        out[k] = v.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, p1: string) => {
          const parts = p1.split('.');
          let cur: unknown = ctx;
          for (const p of parts) {
            if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
              cur = (cur as Record<string, unknown>)[p];
            } else return '';
          }
          return typeof cur === 'string' || typeof cur === 'number' ? String(cur) : JSON.stringify(cur);
        });
      } else out[k] = v;
    }
    return out;
  }

  private async executeWithPolicy(
    step: Step,
    phase: CodePhase,
    input: StepExecutionInput,
  ): Promise<{ kind: 'ok'; exec: StepExecutionOutput } | { kind: 'failed' }> {
    const attempts = step.on_failure === 'retry-once' ? 2 : 1;
    for (let i = 0; i < attempts; i++) {
      try {
        const exec = await this.executor.execute(input);
        return { kind: 'ok', exec };
      } catch (e) {
        this.logger.warn(
          { step_id: step.id, attempt: i + 1, err: (e as Error).message },
          'dispatcher:step_failed',
        );
      }
    }
    return { kind: 'failed' };
  }

  private async postRunWrites(
    input: WorkflowRunInput,
    per_step: WorkflowRunResult['per_step'],
    wf: Workflow,
  ): Promise<void> {
    const successful = per_step.filter((s) => s.status === 'ok');
    const summary = successful.map((s) => `${s.phase}:${s.id}`).join(' → ');
    const classify = {
      yaml_default_kind: wf.para?.default_kind,
      yaml_area_slug: wf.para?.area_slug,
      inferred_area_slug: input.area_slug ?? null,
    };

    await Promise.all([
      this.memory.writeL3({
        agent_id: input.agent_id, job_id: input.job_id,
        text: `Job ${input.job_id} completed: ${summary}`,
      }),
      this.memory.writeL4Agent({
        agent_id: input.agent_id,
        text: `Anonymized pattern: ${summary} · steps_completed=${successful.length}`,
        classify,
      }),
      this.memory.writeL4PerBuyer({
        agent_id: input.agent_id, buyer_addr: input.buyer_addr,
        text: `Buyer engagement summary: ${summary}`,
        classify: { ...classify, is_repeat_buyer_in_area: true },
      }),
      this.memory.writeL5Agent({
        agent_id: input.agent_id,
        text: `Reflection on job ${input.job_id}: ${successful.length}/${per_step.length} steps`,
      }),
      this.memory.writeL5PerBuyer({
        agent_id: input.agent_id, buyer_addr: input.buyer_addr,
        text: `Per-buyer reflection on ${input.job_id}`,
      }),
    ]);
  }
}
