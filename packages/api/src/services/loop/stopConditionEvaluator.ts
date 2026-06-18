/**
 * services/loop/stopConditionEvaluator.ts — PRD-W1 predicate engine.
 *
 * Evaluates structured stop-condition predicates against a job's runtime
 * context. No string eval, no VM2 — predicates are typed AST nodes. This is
 * SAFER than VM2 (no sandbox-escape CVE surface) AND simpler to deploy.
 *
 * Five predicate types (PRD-W §"5 predicate types + composite"):
 *   1. deterministic    — structured AST over typed variables in context
 *   2. llm-judge        — Phala TEE LLM evaluates a free-text criterion
 *   3. metric-threshold — looks up `workflow_run_metrics` row + compares
 *   4. time-window      — current time inside [start_ts, end_ts]
 *   5. composite        — AND/OR/NOT over child predicates
 *
 * SOLID:
 *   - SRP: this module decides "did the stop condition fire?". Settlement
 *     decisions (refund vs full-pay) live in `outcomeEvaluator.ts`.
 *   - OCP: adding a new predicate type = a new branch in `evaluate`. Existing
 *     branches stay byte-identical.
 *   - DIP: I/O dependencies (PgPool for metrics, Phala for llm-judge) are
 *     constructor-injected. Pure-deterministic + composite + time-window
 *     predicates need no I/O at all.
 */

import type { Pool } from 'pg';
import type { Logger } from 'pino';

// ─── Types ──────────────────────────────────────────────────────────

export type ComparisonOp = '==' | '!=' | '>=' | '<=' | '>' | '<';

export type AstNode =
  | { kind: 'literal'; value: number | string | boolean }
  | { kind: 'var'; name: string }
  | { kind: 'compare'; op: ComparisonOp; left: AstNode; right: AstNode }
  | { kind: 'and'; children: AstNode[] }
  | { kind: 'or'; children: AstNode[] }
  | { kind: 'not'; child: AstNode };

export type Predicate =
  | { type: 'deterministic'; expr: AstNode }
  | { type: 'llm-judge'; criteria: string; model_id?: string }
  | {
      type: 'metric-threshold';
      job_id: string;
      metric: string;
      op: ComparisonOp;
      value: number;
    }
  | { type: 'time-window'; start_ts_ms: number; end_ts_ms: number }
  | { type: 'composite'; op: 'AND' | 'OR' | 'NOT'; children: Predicate[] };

export interface EvaluationContext {
  /** Variables exposed to deterministic predicates. */
  vars: Record<string, number | string | boolean>;
  /** Used for time-window if absent → Date.now(). Tests inject a clock. */
  now_ms?: number;
}

export interface EvaluationResult {
  satisfied: boolean;
  /** Why — for buyer-visible transparency in B6. */
  reason: string;
}

export interface LlmJudge {
  judge(criteria: string, vars: Record<string, unknown>, model_id?: string):
    Promise<{ satisfied: boolean; reason: string }>;
}

export interface StopConditionDeps {
  pool: Pool;
  llm?: LlmJudge;
  logger: Logger;
}

// ─── Pure deterministic AST evaluator ───────────────────────────────

function evalAst(node: AstNode, vars: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'literal':
      return node.value;
    case 'var': {
      if (!Object.prototype.hasOwnProperty.call(vars, node.name)) {
        throw new Error(`stopCondition: unknown var "${node.name}"`);
      }
      return vars[node.name];
    }
    case 'compare': {
      const l = evalAst(node.left, vars);
      const r = evalAst(node.right, vars);
      switch (node.op) {
        case '==': return l === r;
        case '!=': return l !== r;
        case '>': return Number(l) > Number(r);
        case '<': return Number(l) < Number(r);
        case '>=': return Number(l) >= Number(r);
        case '<=': return Number(l) <= Number(r);
      }
    }
    // eslint-disable-next-line no-fallthrough
    case 'and':
      return node.children.every((c) => Boolean(evalAst(c, vars)));
    case 'or':
      return node.children.some((c) => Boolean(evalAst(c, vars)));
    case 'not':
      return !evalAst(node.child, vars);
  }
}

// ─── Service ─────────────────────────────────────────────────────────

export class StopConditionEvaluator {
  constructor(private readonly deps: StopConditionDeps) {}

  async evaluate(predicate: Predicate, ctx: EvaluationContext): Promise<EvaluationResult> {
    try {
      switch (predicate.type) {
        case 'deterministic': {
          const ok = Boolean(evalAst(predicate.expr, ctx.vars));
          return { satisfied: ok, reason: ok ? 'deterministic predicate true' : 'deterministic predicate false' };
        }
        case 'time-window': {
          const now = ctx.now_ms ?? Date.now();
          const ok = now >= predicate.start_ts_ms && now <= predicate.end_ts_ms;
          return { satisfied: ok, reason: ok ? 'within time window' : 'outside time window' };
        }
        case 'metric-threshold': {
          const row = await this.deps.pool.query(
            `SELECT metric_value FROM workflow_run_metrics
              WHERE job_id = $1 AND metric_name = $2
              ORDER BY recorded_at DESC LIMIT 1`,
            [predicate.job_id, predicate.metric],
          );
          if (row.rowCount === 0) {
            return { satisfied: false, reason: `metric "${predicate.metric}" not recorded` };
          }
          const observed = Number(row.rows[0].metric_value);
          const ok = compareNum(observed, predicate.op, predicate.value);
          return {
            satisfied: ok,
            reason: `${predicate.metric}=${observed} ${predicate.op} ${predicate.value} → ${ok}`,
          };
        }
        case 'llm-judge': {
          if (!this.deps.llm) {
            this.deps.logger.warn('stopCondition: llm-judge requested but no LlmJudge injected');
            return { satisfied: false, reason: 'llm-judge unavailable' };
          }
          return this.deps.llm.judge(predicate.criteria, ctx.vars, predicate.model_id);
        }
        case 'composite': {
          const evaluated = await Promise.all(
            predicate.children.map((child) => this.evaluate(child, ctx)),
          );
          if (predicate.op === 'NOT') {
            const inner = evaluated[0];
            return { satisfied: !inner.satisfied, reason: `NOT(${inner.reason})` };
          }
          if (predicate.op === 'AND') {
            const ok = evaluated.every((e) => e.satisfied);
            return { satisfied: ok, reason: `AND: ${evaluated.map((e) => e.reason).join('; ')}` };
          }
          // OR
          const ok = evaluated.some((e) => e.satisfied);
          return { satisfied: ok, reason: `OR: ${evaluated.map((e) => e.reason).join('; ')}` };
        }
      }
    } catch (e) {
      this.deps.logger.error({ err: (e as Error).message, predicate }, 'stopCondition:eval:error');
      return { satisfied: false, reason: `error: ${(e as Error).message}` };
    }
  }
}

function compareNum(observed: number, op: ComparisonOp, target: number): boolean {
  switch (op) {
    case '==': return observed === target;
    case '!=': return observed !== target;
    case '>': return observed > target;
    case '<': return observed < target;
    case '>=': return observed >= target;
    case '<=': return observed <= target;
  }
}
