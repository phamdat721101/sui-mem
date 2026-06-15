/**
 * llmInference.ts — LLM inference adapter for OpenX agents.
 *
 * Replaces the prior Phala TEE inference with AWS Bedrock (Claude). The
 * privacy story is now Seal-only: brain blobs are sealed by Seal IBE and
 * unwrapped per-query against an on-chain payment proof; inference runs on
 * commodity Bedrock infra. The attestation envelope on every response
 * names the LLM provider so buyers can verify which model answered.
 *
 * SOLID:
 *  - Liskov: every implementation satisfies `LlmInferenceClient` exactly.
 *  - OCP: a future provider (e.g. an open-weights gateway) plugs in by adding
 *    one class; the factory grows by one branch.
 *  - DIP: callers depend on the interface, never on `fetch` or AWS SDKs.
 *
 * Mistake-avoidance: every external call goes through `resilientCall`. A
 * caller-supplied `fallback` is invoked on circuit-open.
 */

import type { AttestationReceipt } from '@fhe-ai-context/sdk';
import {
  resilientCall,
  CircuitOpenError,
  type ResilientLogger,
} from '@fhe-ai-context/runtime-utils';

export interface InferenceMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface InferenceOptions {
  /** Stop the answer at N tokens. Default 1024. */
  maxTokens?: number;
  /** 0 (deterministic) … 1 (creative). Default 0.2. */
  temperature?: number;
  logger?: ResilientLogger;
  /** Called when the provider circuit is OPEN — caller decides whether to fall back. */
  fallback?: (msgs: InferenceMessage[]) => Promise<{ answer: string; attestation?: AttestationReceipt }>;
}

export interface InferenceResult {
  answer: string;
  attestation: AttestationReceipt;
}

/**
 * Public adapter contract. The legacy name `PhalaInferenceClient` is
 * re-exported as a deprecated alias at the bottom of this file so existing
 * callers (smokes, scripts) compile until they migrate.
 */
export interface LlmInferenceClient {
  infer(messages: InferenceMessage[], opts?: InferenceOptions): Promise<InferenceResult>;
}

export interface BedrockConfig {
  /** AWS region. Default `us-east-1`. */
  region?: string;
  /** Bedrock API key (Bearer). */
  apiKey?: string;
  /** Bedrock model id. Default `anthropic.claude-3-5-haiku-20241022-v1:0`. */
  modelId?: string;
}

// ---------- Mock implementation --------------------------------------------

class MockLlmClient implements LlmInferenceClient {
  async infer(messages: InferenceMessage[], _opts: InferenceOptions = {}): Promise<InferenceResult> {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const sysContext = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    const summary = sysContext ? sysContext.slice(0, 200) : '(no source chunks)';
    const answer =
      `Based on your encrypted brain (${summary.length} chars of source context), ` +
      `here is the mock answer to: "${lastUser}". ` +
      `Set BEDROCK_API_KEY to enable real inference.`;
    return {
      answer,
      attestation: {
        provider: 'mock',
        quote: `mock-attestation:${Date.now().toString(16)}`,
        verified: true,
        issuedAt: new Date().toISOString(),
      },
    };
  }
}

// ---------- Bedrock implementation ----------------------------------------
//
// Anthropic Messages API on Bedrock. Auth: `Authorization: Bearer <api_key>`
// using the long-lived API key (prefix `ABSK…`). The OpenAI-shaped
// `messages: [{role,content}]` is translated into Bedrock's Anthropic
// schema where the `system` prompt is a top-level field.

interface BedrockResponse {
  content?: Array<{ type: string; text?: string }>;
  stop_reason?: string;
}

class BedrockClient implements LlmInferenceClient {
  constructor(private readonly cfg: Required<BedrockConfig>) {}

  async infer(messages: InferenceMessage[], opts: InferenceOptions = {}): Promise<InferenceResult> {
    const url = `https://bedrock-runtime.${this.cfg.region}.amazonaws.com/model/${encodeURIComponent(this.cfg.modelId)}/invoke`;
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n').trim();
    const turns = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.content }));
    if (turns.length === 0) {
      throw new Error('llmInference: at least one user message required');
    }

    const body = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: opts.maxTokens ?? 1024,
      temperature: opts.temperature ?? 0.2,
      system: system || undefined,
      messages: turns,
    };

    try {
      return await resilientCall(
        { name: 'bedrock-llm-inference', logger: opts.logger },
        async () => {
          const res = await fetch(url, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.cfg.apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
          });
          if (!res.ok) {
            const txt = await res.text().catch(() => '');
            throw new Error(`bedrock ${res.status}: ${txt.slice(0, 200)}`);
          }
          const data = (await res.json()) as BedrockResponse;
          const answer = (data.content ?? [])
            .filter((p) => p.type === 'text')
            .map((p) => p.text ?? '')
            .join('');
          return {
            answer,
            attestation: {
              provider: 'bedrock',
              quote: `bedrock:${this.cfg.modelId}:${this.cfg.region}`,
              verified: true,
              issuedAt: new Date().toISOString(),
            },
          };
        },
      );
    } catch (err) {
      if (err instanceof CircuitOpenError && opts.fallback) {
        const fb = await opts.fallback(messages);
        return {
          answer: fb.answer,
          attestation: fb.attestation ?? {
            provider: 'fallback',
            quote: '',
            verified: false,
            issuedAt: new Date().toISOString(),
          },
        };
      }
      throw err;
    }
  }
}

// ---------- Factory --------------------------------------------------------

export function createLlmClient(cfg: BedrockConfig = {}): LlmInferenceClient {
  const region = cfg.region ?? process.env.AWS_REGION ?? process.env.BEDROCK_REGION ?? 'us-east-1';
  const apiKey = cfg.apiKey ?? process.env.BEDROCK_API_KEY;
  const modelId =
    cfg.modelId ?? process.env.BEDROCK_MODEL_ID ?? 'anthropic.claude-3-5-haiku-20241022-v1:0';
  if (!apiKey) return new MockLlmClient();
  return new BedrockClient({ region, apiKey, modelId });
}

// ---------- Back-compat aliases (deprecated) -------------------------------
// Retained so existing callers (scripts/, packages that haven't been touched
// in this refactor) keep compiling. Migrate to the new names in new code.

/** @deprecated Use `LlmInferenceClient`. */
export type PhalaInferenceClient = LlmInferenceClient;
/** @deprecated Use `BedrockConfig`. The old Phala fields are no longer read. */
export type PhalaConfig = BedrockConfig;
/** @deprecated Use `createLlmClient(cfg)`. */
export const createPhalaClient = createLlmClient;
