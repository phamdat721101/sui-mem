/**
 * services/loop/outcomeEvaluator.ts — PRD-W4 outcome-priced settlement.
 *
 * Wraps StopConditionEvaluator with the additional logic that converts
 * a satisfied/not-satisfied predicate into a settlement decision:
 *   - satisfied → full payout (70/25/5 split per agent manifest)
 *   - partial   → pro-rata refund (steps_completed / steps_total)
 *   - failed    → max refund minus operator gas burned
 *
 * Pre-mortem T1 mitigation: predicate eval runs in the same Phala TEE that
 * served the workflow → buyer can verify attestation. T5 mitigation:
 * iter-priced fallback path is preserved (this module is only reached when
 * `LoopJob.outcome_pricing = true`).
 *
 * SOLID:
 *   - SRP: produces a settlement decision; the Move call lives in the
 *     dispatcher (`workflowDispatcher.complete_with_outcome`).
 *   - DIP: StopConditionEvaluator injected; tests stub the predicate verdict.
 */

import type { Logger } from 'pino';
import {
  StopConditionEvaluator,
  type Predicate,
  type EvaluationContext,
} from './stopConditionEvaluator';

export type SettlementVerdict = 'full' | 'partial' | 'failed';

export interface OutcomeDecision {
  verdict: SettlementVerdict;
  /** Used as the `evidence_blob_id` arg of the on-chain Move call. */
  evidence_blob_id: string;
  /** Bps (0..10_000) of the budget the buyer pays. 10_000 = full. */
  pay_bps: number;
  reason: string;
}

export interface OutcomeInput {
  predicate: Predicate;
  ctx: EvaluationContext;
  steps_total: number;
  steps_completed: number;
  /** SHA-256 hex of the Phala attestation quote — written on-chain as evidence. */
  attestation_hex: string;
}

export class OutcomeEvaluator {
  constructor(
    private readonly stop: StopConditionEvaluator,
    private readonly logger: Logger,
  ) {}

  async decide(input: OutcomeInput): Promise<OutcomeDecision> {
    const result = await this.stop.evaluate(input.predicate, input.ctx);

    // Full success — outcome predicate fired.
    if (result.satisfied) {
      return {
        verdict: 'full',
        evidence_blob_id: input.attestation_hex,
        pay_bps: 10_000,
        reason: result.reason,
      };
    }

    // Partial success — workflow advanced but predicate not satisfied.
    if (input.steps_completed > 0 && input.steps_completed < input.steps_total) {
      const bps = Math.floor((input.steps_completed / input.steps_total) * 10_000);
      this.logger.info(
        { steps_completed: input.steps_completed, steps_total: input.steps_total, bps },
        'outcome:partial',
      );
      return {
        verdict: 'partial',
        evidence_blob_id: input.attestation_hex,
        pay_bps: bps,
        reason: `partial: ${input.steps_completed}/${input.steps_total} steps · ${result.reason}`,
      };
    }

    // No progress — refund everything (operator absorbs gas).
    return {
      verdict: 'failed',
      evidence_blob_id: input.attestation_hex,
      pay_bps: 0,
      reason: `failed: ${result.reason}`,
    };
  }
}
