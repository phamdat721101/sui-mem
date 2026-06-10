/**
 * Phala TEE inference adapter.
 *
 * Encapsulates "ask the LLM and prove it ran inside an attested enclave".
 * Two implementations:
 *   - **mock**: deterministic answer + a synthetic attestation receipt that
 *     always verifies. Lets us exercise the chat → attestation surface offline.
 *   - **http**: posts to Phala Cloud's Confidential AI API (OpenAI-compatible)
 *     and returns the GPU/TDX/SEV attestation quote alongside the answer.
 *
 * SOLID:
 * - Liskov: both implementations satisfy `PhalaInferenceClient` exactly.
 * - Open/Closed: a future TEE provider plugs in by adding a third class.
 * - Dependency Inversion: `SealBrainClient` depends on the interface only.
 *
 * Mistake-avoidance: every external call goes through `resilientCall`. A
 * caller-supplied `fallback` is invoked when the Phala circuit is OPEN.
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
  /** Stop the answer at N tokens (best-effort). Default 512. */
  maxTokens?: number;
  /** 0 (deterministic) … 1 (creative). Default 0.2. */
  temperature?: number;
  logger?: ResilientLogger;
  /** Called when the Phala circuit is OPEN — caller decides whether to fall back. */
  fallback?: (msgs: InferenceMessage[]) => Promise<{ answer: string; attestation?: AttestationReceipt }>;
}

export interface InferenceResult {
  answer: string;
  attestation: AttestationReceipt;
}

export interface PhalaInferenceClient {
  infer(messages: InferenceMessage[], opts?: InferenceOptions): Promise<InferenceResult>;
}

export interface PhalaConfig {
  /** Base URL for Phala Cloud OpenAI-compatible endpoint. */
  endpoint?: string;
  /** API key. */
  apiKey?: string;
  /** Model name. Defaults to a confidential Llama variant. */
  model?: string;
}

// ---------- Mock implementation --------------------------------------------

class MockPhalaClient implements PhalaInferenceClient {
  async infer(messages: InferenceMessage[], _opts: InferenceOptions = {}): Promise<InferenceResult> {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const sysContext = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    const summary = sysContext ? sysContext.slice(0, 200) : '(no source chunks)';
    const answer =
      `Based on your encrypted brain (${summary.length} chars of source context), ` +
      `here is the mock answer to: "${lastUser}". ` +
      `Phala TEE inference will replace this when PHALA_API_KEY is set.`;
    return {
      answer,
      attestation: {
        provider: 'phala-tee',
        quote: `mock-tdx-quote:${Date.now().toString(16)}`,
        verified: true,
        issuedAt: new Date().toISOString(),
      },
    };
  }
}

// ---------- HTTP implementation -------------------------------------------

class HttpPhalaClient implements PhalaInferenceClient {
  constructor(private readonly cfg: Required<PhalaConfig>) {}

  async infer(messages: InferenceMessage[], opts: InferenceOptions = {}): Promise<InferenceResult> {
    try {
      return await resilientCall(
        { name: 'phala-tee-inference', logger: opts.logger },
        async () => {
          const res = await fetch(`${this.cfg.endpoint}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${this.cfg.apiKey}`,
            },
            body: JSON.stringify({
              model: this.cfg.model,
              messages,
              max_tokens: opts.maxTokens ?? 512,
              temperature: opts.temperature ?? 0.2,
            }),
          });
          if (!res.ok) throw new Error(`phala ${res.status}`);
          const data = (await res.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
            attestation?: { quote?: string; issued_at?: string };
          };
          const answer = data.choices?.[0]?.message?.content ?? '';
          const quote = data.attestation?.quote ?? '';
          return {
            answer,
            attestation: {
              provider: 'phala-tee',
              quote,
              verified: Boolean(quote),
              issuedAt: data.attestation?.issued_at ?? new Date().toISOString(),
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

export function createPhalaClient(cfg: PhalaConfig = {}): PhalaInferenceClient {
  const endpoint = cfg.endpoint ?? process.env.PHALA_ENDPOINT;
  const apiKey = cfg.apiKey ?? process.env.PHALA_API_KEY;
  const model = cfg.model ?? process.env.PHALA_MODEL ?? 'meta-llama/Llama-3.1-8B-Instruct';
  if (!endpoint || !apiKey) return new MockPhalaClient();
  return new HttpPhalaClient({ endpoint, apiKey, model });
}
