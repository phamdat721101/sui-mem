/**
 * services/loop/llmJudgeCheckpoint.ts — PRD-W5 LLM-judge auto-approve.
 *
 * For workflow steps with `risk_tier='low'` the dispatcher can ask an LLM
 * judge whether the step output meets the workflow's acceptance schema.
 * If the judge returns `auto_approve: true` with confidence ≥0.8 the
 * checkpoint passes without a buyer round-trip. Medium/high risk always
 * goes to the buyer (B5 Distill checkpoint modal).
 *
 * SOLID: SRP — judging only. The actual "pause workflow + render UI"
 * logic lives in workflowDispatcher. This module is a pure delegate.
 */

import type { Logger } from 'pino';

export type RiskTier = 'low' | 'medium' | 'high';

export interface CheckpointVerdict {
  auto_approve: boolean;
  confidence: number;  // 0..1
  reason: string;
}

export interface LlmJudgeBackend {
  /** Calls Phala TEE LLM with a structured comparison prompt. */
  evaluate(args: {
    step_output: Record<string, unknown>;
    expected_schema: Record<string, string>;
    system_prompt?: string;
  }): Promise<{ confidence: number; reason: string }>;
}

export interface LlmJudgeDeps {
  backend: LlmJudgeBackend;
  logger: Logger;
}

const CONFIDENCE_THRESHOLD = 0.8;

export class LlmJudgeCheckpoint {
  constructor(private readonly deps: LlmJudgeDeps) {}

  async judge(args: {
    risk_tier: RiskTier;
    step_output: Record<string, unknown>;
    expected_schema?: Record<string, string>;
  }): Promise<CheckpointVerdict> {
    // Hard rule: medium/high always require human approval.
    if (args.risk_tier !== 'low') {
      return { auto_approve: false, confidence: 1, reason: `risk=${args.risk_tier} requires buyer review` };
    }
    if (!args.expected_schema || Object.keys(args.expected_schema).length === 0) {
      return { auto_approve: false, confidence: 0, reason: 'no expected_schema → cannot judge' };
    }

    try {
      const r = await this.deps.backend.evaluate({
        step_output: args.step_output,
        expected_schema: args.expected_schema,
      });
      const auto = r.confidence >= CONFIDENCE_THRESHOLD;
      return { auto_approve: auto, confidence: r.confidence, reason: r.reason };
    } catch (e) {
      this.deps.logger.warn({ err: (e as Error).message }, 'llmJudge:backend_failed_fallback_to_human');
      return { auto_approve: false, confidence: 0, reason: `judge error: ${(e as Error).message}` };
    }
  }
}
