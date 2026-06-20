/**
 * services/loop/phalaStepExecutor.ts — PRD-X5 real step executor.
 *
 * Closes W-B6: `mockStepExecutor.ts` was the only `StepExecutor` impl,
 * meaning every workflow step today returns synthetic templates. This
 * executor calls the existing Phala TEE client (the same one `services/chat.ts`
 * uses) and returns a real attestation hash per step. Mock stays as the
 * default + CI fallback (gated by `FEATURE_LOOP_PHALA_EXEC=true`).
 *
 * Failure mode: on Phala timeout / 5xx / parse failure, the executor falls
 * back to a deterministic Bedrock-style response (when `bedrockFallback=true`)
 * with attestation_hex prefixed `bedrock-fallback:` so dashboards can
 * distinguish degraded vs real paths.
 *
 * SOLID:
 *   - SRP: one verb (`execute`). Prompt + parse + cost compute only.
 *   - DIP: phala client constructor-injected (testable without network).
 *   - LSP: drop-in replacement for `MockStepExecutor` — identical
 *     `StepExecutor` interface declared in workflowDispatcher.ts.
 *   - OCP: per-risk model ladder (Haiku for low-risk, Sonnet for distill,
 *     Opus for high-risk) is a future extension that adds resolveModelId
 *     branches without changing this class shape.
 *
 * SLA per Master PRD §5.5:
 *   p50 ≤12s · p95 ≤30s · p99 ≤60s · hard timeout 60s.
 */

import { createHash } from 'node:crypto';
import type {
  StepExecutor,
  StepExecutionInput,
  StepExecutionOutput,
} from './workflowDispatcher';

/** Minimal Phala client surface this executor depends on. */
export interface PhalaInfClient {
  infer(messages: Array<{ role: 'system' | 'user'; content: string }>): Promise<{
    answer: string;
    attestation: { quote?: string; provider?: string; verified?: boolean };
  }>;
}

/** Bedrock fallback — a single-method shape so tests can pass any LLM. */
export interface BedrockFallbackClient {
  infer(messages: Array<{ role: 'system' | 'user'; content: string }>): Promise<{
    answer: string;
  }>;
}

export interface PhalaExecutorConfig {
  /** Per-step hard timeout. Default 60_000ms. CI: 0 disables timeout. */
  timeoutMs?: number;
  /** Max retry attempts beyond the initial call. Default 1. */
  maxRetries?: number;
  /** When true, fall back to bedrock on any Phala failure. Default true. */
  bedrockFallback?: boolean;
}

export interface PhalaExecutorDeps {
  phala: PhalaInfClient;
  bedrock?: BedrockFallbackClient;
  cfg?: PhalaExecutorConfig;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export class PhalaStepExecutor implements StepExecutor {
  constructor(private readonly deps: PhalaExecutorDeps) {}

  async execute(input: StepExecutionInput): Promise<StepExecutionOutput> {
    const t0 = Date.now();
    const prompt = this.buildPrompt(input);

    const cfg = this.deps.cfg ?? {};
    const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxRetries = cfg.maxRetries ?? 1;
    const bedrockOk = cfg.bedrockFallback !== false;

    let phalaErr: Error | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const r = await this.withTimeout(
          () => this.deps.phala.infer([
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ]),
          timeoutMs,
        );
        const output = this.parseResponse(r.answer, input.step.output_schema);
        const attestation_hex = pickAttestationHex(r.attestation, t0, input);
        const spent_micro = this.computeSpentMicro(input.step.max_micro_usdc, t0);
        return { output, spent_micro, attestation_hex };
      } catch (e) {
        phalaErr = e as Error;
      }
    }

    // Phala exhausted retries — try Bedrock fallback if enabled + provided.
    if (bedrockOk && this.deps.bedrock) {
      try {
        const r = await this.deps.bedrock.infer([
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ]);
        const output = this.parseResponse(r.answer, input.step.output_schema);
        const attestation_hex = `bedrock-fallback:${sha(input, t0)}`;
        const spent_micro = this.computeSpentMicro(input.step.max_micro_usdc, t0);
        return { output, spent_micro, attestation_hex };
      } catch {
        // fall through; surface the original Phala error.
      }
    }
    throw phalaErr ?? new Error('phala:exec:unknown_failure');
  }

  /** Compose system + user prompts. Warm-context capped to keep tokens predictable. */
  private buildPrompt(input: StepExecutionInput): { system: string; user: string } {
    const general = input.warm_context.agent_general
      .slice(0, 5)
      .map((h) => `- ${h.text.slice(0, 240)}`)
      .join('\n') || '(none)';
    const perBuyer = input.warm_context.per_buyer
      .slice(0, 5)
      .map((h) => `- ${h.text.slice(0, 240)}`)
      .join('\n') || '(none)';
    const schema = input.step.output_schema
      ? JSON.stringify(input.step.output_schema, null, 2)
      : '(no schema — return JSON object)';
    const system = [
      `You are a workflow agent executing the "${input.step.capability}" step (phase=${input.phase}).`,
      'Respond with strict JSON matching the output schema. No prose, no markdown fences.',
      'Output schema:',
      schema,
    ].join('\n');
    const user = [
      '## Warm context — agent general',
      general,
      '',
      '## Warm context — this buyer',
      perBuyer,
      '',
      '## Step inputs',
      JSON.stringify(input.resolved_inputs, null, 2),
    ].join('\n');
    return { system, user };
  }

  /** Parse JSON; on failure, wrap raw text into the first schema key (or `text`). */
  private parseResponse(
    answer: string,
    schema: Record<string, string> | undefined,
  ): Record<string, unknown> {
    try {
      const trimmed = answer.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through
    }
    const fallbackKey = (schema && Object.keys(schema)[0]) ?? 'text';
    return { [fallbackKey]: answer };
  }

  /** Cost model: capped by step.max_micro_usdc; weakly proportional to wallclock. */
  private computeSpentMicro(maxMicroUsdc: number, t0: number): number {
    const elapsed = Math.max(1, Date.now() - t0);
    // Soft model: 1 µUSDC per ms of TEE wallclock, capped at the step's max.
    return Math.min(maxMicroUsdc, elapsed);
  }

  private async withTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
    if (!ms || ms <= 0) return fn();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`phala:timeout_${ms}ms`)), ms);
      fn().then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    });
  }
}

function pickAttestationHex(
  attestation: { quote?: string; verified?: boolean } | undefined,
  t0: number,
  input: StepExecutionInput,
): string {
  if (attestation?.quote && attestation.verified) return attestation.quote;
  // Phala returned but unverified — still real Phala, just untrusted quote.
  if (attestation?.quote) return `phala-unverified:${attestation.quote}`;
  // Defensive: missing quote — synthesize a deterministic id.
  return `phala-no-quote:${sha(input, t0)}`;
}

function sha(input: StepExecutionInput, t0: number): string {
  return createHash('sha256')
    .update(`${input.agent_id}::${input.step.id}::${input.job_id}::${t0}`)
    .digest('hex');
}
