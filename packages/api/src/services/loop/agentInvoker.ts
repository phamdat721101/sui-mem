/**
 * services/loop/agentInvoker.ts — the shared 12-step inference pipeline that
 * both Mode A (x402 fast lane) and Mode B (loop iter advance) call into.
 *
 * Translates arb-mem's Pinata + Fhenix flow to Walrus + Seal IBE + Phala TEE
 * — every primitive is already shipped in `@openx/sui-sdk`; this file is the
 * thin orchestrator.
 *
 * 12 steps:
 *   1.  Validate manifest (persona prompt non-empty).
 *   2.  Resolve user text — inline `inputs.text` OR Walrus-fetch + Seal-decrypt.
 *   3.  Apply word-limit guard (Tiger-4 mitigation).
 *   4.  Invoke Phala TEE inference (existing PhalaInferenceClient).
 *   5.  AES-GCM-encrypt the response with a fresh key.
 *   6.  Walrus-upload the response ciphertext.
 *   7.  Seal-encrypt the response key for the buyer's per-job policy.
 *   8.  Compute SHA-256 digest of plaintext (for receipt).
 *   9.  Measure runner-memory window; emit soft alarm if > 30s.
 *  10.  Return ciphertext bundle (no plaintext leaks the boundary).
 *
 * (Steps 11–12 from arb-mem — Fhenix encrypt-for-buyer + return — fold into
 * step 7 because Seal IBE wraps the buyer's identity directly into the
 * threshold policy; no separate gateway encrypt call.)
 *
 * SOLID:
 *   - SRP: this class is the pipeline. Mode-specific concerns (settlement,
 *     iter advance) live OUTSIDE in `middleware/loopX402.ts` (Mode A) or
 *     the runner worker (Mode B).
 *   - DIP: `seal`, `walrus`, `phala`, `logger` injected via constructor.
 *     Tests pass mocks; production builds via `loadDefaults()`.
 *   - LSP: result shape is uniform across modes; the route handler / runner
 *     decide what to do with `responseBlobId`.
 */

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import {
  loopPolicyIdentity,
  type MemWalAdapterLogger as Logger,
} from '@fhe-ai-context/sdk';
import {
  createSealKeyClient,
  createWalrusStore,
  createPhalaClient,
  type SealKeyClient,
  type PhalaInferenceClient,
  type WalrusStore,
} from '@fhe-ai-context/sui-sdk';
import { pool } from '../../db';
import { MemoryService, type WarmContextResult } from './memoryService';

const RUNNER_MEM_SOFT_LIMIT_MS = 30_000;
const MODE_A_MEMORY_FLAG = 'FEATURE_LOOP_MODE_A_MEMORY';

const noopMirror = { remember: async () => null };

export interface AgentManifest {
  title: string;
  persona_system_prompt: string;
  default_model_id?: string;
  word_limit?: number;
  /** Optional PARA area tag — surfaces in vault rows + Mode A memory writes. */
  area_slug?: string | null;
}

export interface InvokeAgentInputs {
  agentObjectId: string;            // Sui shared-object id
  buyerAddress: `0x${string}`;
  jobNonce: string;                  // Mode A: fresh; Mode B: LoopJob object id + iter
  manifest: AgentManifest;
  /** Buyer-supplied input. Either `text` inline or a Walrus blob + Seal key. */
  inputs: {
    text?: string;
    walrus_blob_id?: string;
    sealed_aes_key?: Uint8Array;   // Seal-IBE wrapped AES-GCM key
    iv?: Uint8Array;
  };
  correlationId: string;
  /** On-chain settlement digest (from `loopX402Middleware.req.loopX402Settlement`).
   *  Stored on the L2 memory row for buyer-verifiable on-chain provenance. */
  suiTxDigest?: string | null;
}

export interface InvokeAgentResult {
  responseWalrusBlobId: string;
  /** Seal-IBE wrapped response AES key — only the buyer can derive a
   *  decryption capability under the per-job policy. */
  sealedResponseKey: Uint8Array;
  responseIv: Uint8Array;
  responseDigestSha256: `0x${string}`;
  attestation: {
    provider: string;
    quote: string;
    verified: boolean;
    issuedAt: string;
  };
  runnerMemoryMs: number;
}

export interface AgentInvokerDeps {
  seal: SealKeyClient;
  walrus: WalrusStore;
  phala: PhalaInferenceClient;
  /** MemoryService — when injected and FEATURE_LOOP_MODE_A_MEMORY=true,
   *  Mode A reads warm context (step 2.5) and fires async writes (step 9b). */
  memory?: MemoryService;
  logger?: Logger;
}

export class LoopAgentInvoker {
  constructor(private readonly deps: AgentInvokerDeps) {}

  /** Build the production-default invoker from env + the existing sui-sdk factories. */
  static loadDefaults(logger?: Logger): LoopAgentInvoker {
    return new LoopAgentInvoker({
      seal: createSealKeyClient(),
      walrus: createWalrusStore(),
      phala: createPhalaClient(),
      memory: new MemoryService({ pool, mirror: noopMirror, logger: logger as never }),
      logger,
    });
  }

  async invoke(args: InvokeAgentInputs): Promise<InvokeAgentResult> {
    const t0 = Date.now();
    const log = (event: string, fields: Record<string, unknown> = {}) =>
      this.deps.logger?.info({ event, correlation_id: args.correlationId, ...fields }, event);

    log('loop:invoke:begin', { agent_id: args.agentObjectId });

    // 1. Manifest validation.
    if (!args.manifest.persona_system_prompt) {
      throw new Error('loop:invoke:bad_manifest:missing_system_prompt');
    }

    // 2. Resolve user text — inline OR encrypted Walrus blob.
    const userText = await this.resolveUserText(args, log);
    if (!userText) throw new Error('loop:invoke:no_input_text');

    // 3. Word-limit guard.
    if (args.manifest.word_limit && userText.split(/\s+/).length > args.manifest.word_limit) {
      throw new Error(`loop:invoke:word_limit_exceeded:${args.manifest.word_limit}`);
    }

    // 2.5 Warm-context recall (Mode A F6 reflexive loop).
    // Reads cog-l4-{agent_id} + cog-l4-{agent_id}-{buyer_addr} via a single
    // SQL query. Soft-fail: any error degrades to no recall, never blocks
    // the paid call.
    let warmContext: WarmContextResult | null = null;
    if (this.deps.memory && process.env[MODE_A_MEMORY_FLAG] === 'true') {
      try {
        warmContext = await this.deps.memory.readWarmContext({
          agent_id: args.agentObjectId,
          buyer_addr: args.buyerAddress,
          area_slug: args.manifest.area_slug ?? undefined,
          limit: 8,
        });
        log('mode-a:warm_context_loaded', {
          general: warmContext.agent_general.length,
          per_buyer: warmContext.per_buyer.length,
        });
      } catch (e) {
        this.deps.logger?.warn(
          { err: (e as Error).message, correlation_id: args.correlationId },
          'mode-a:warm_context_failed_continue',
        );
        warmContext = null;
      }
    }

    // 4. Phala TEE inference.
    log('loop:invoke:phala');
    const augmentedSystemPrompt = augmentSystemPrompt(args.manifest.persona_system_prompt, warmContext);
    const inf = await this.deps.phala.infer([
      { role: 'system', content: augmentedSystemPrompt },
      { role: 'user', content: userText },
    ]);
    log('loop:invoke:phala_done', { response_chars: inf.answer.length, attested: inf.attestation.verified });

    // 5–6. AES-GCM encrypt + Walrus upload.
    const { aesGcmEncrypt } = await import('@fhe-ai-context/sdk');
    const responseBytes = new TextEncoder().encode(inf.answer);
    const enc = await aesGcmEncrypt(responseBytes);
    const upload = await this.deps.walrus.upload(enc.ciphertext);
    if (!upload.blobs.length) throw new Error('loop:invoke:walrus_upload_no_blob');
    const responseWalrusBlobId = upload.blobs[0].blobId;
    log('loop:invoke:walrus_uploaded', { blob_id: responseWalrusBlobId, size: upload.totalBytes });

    // 7. Seal-encrypt the response key for the buyer's per-job policy.
    const identity = loopPolicyIdentity({
      agentObjectId: args.agentObjectId,
      jobNonce: args.jobNonce,
      buyerAddr: args.buyerAddress,
    });
    const sealedResponseKey = await this.deps.seal.encryptKey({ identity, key: enc.key });

    // 8. Response digest (receipt).
    const digest = ('0x' + bytesToHex(sha256(responseBytes))) as `0x${string}`;

    // 9. Soft-alarm if we held cleartext > 30s.
    const runnerMemoryMs = Date.now() - t0;
    if (runnerMemoryMs > RUNNER_MEM_SOFT_LIMIT_MS) {
      this.deps.logger?.warn(
        { ms: runnerMemoryMs, correlation_id: args.correlationId },
        'loop:invoke:slow',
      );
    }

    log('loop:invoke:done', { ms: runnerMemoryMs, blob_id: responseWalrusBlobId });

    // 9b. Fire-and-forget memory writes (Mode A F6 reflexive loop).
    // setImmediate ensures the buyer response returns first; writes happen
    // off the hot path. Each write soft-fails independently. Latency drag
    // on the buyer-visible call: 0ms.
    if (this.deps.memory && process.env[MODE_A_MEMORY_FLAG] === 'true') {
      const memory = this.deps.memory;
      const recordedAt = new Date().toISOString();
      const promptExcerpt = userText.slice(0, 1000);
      const responseExcerpt = inf.answer.slice(0, 2000);
      const isRepeatBuyer = !!(warmContext && warmContext.per_buyer.length > 0);
      const baseClassify = {
        is_repeat_buyer_in_area: isRepeatBuyer,
        area_slug: args.manifest.area_slug ?? null,
        explicit_para_kind: null,
      };
      const summary =
        `${args.manifest.area_slug ?? 'unfiled'} paid call · ${runnerMemoryMs}ms · ${args.suiTxDigest ?? 'no-tx'}`;
      const safeWarn = (event: string) => (e: Error) =>
        this.deps.logger?.warn({ err: e.message, event, correlation_id: args.correlationId }, event);

      setImmediate(() => {
        // L2 — episodic per-step.
        void memory.writeL2({
          agent_id: args.agentObjectId,
          job_id: args.jobNonce,
          step_id: 'mode-a-paid-call',
          text: JSON.stringify({
            recorded_at: recordedAt,
            prompt_excerpt: promptExcerpt,
            response_excerpt: responseExcerpt,
            duration_ms: runnerMemoryMs,
            sui_tx_digest: args.suiTxDigest ?? null,
            response_walrus_blob_id: responseWalrusBlobId,
          }).slice(0, 4000),
        }).catch(safeWarn('mode-a:writeL2_failed'));

        // L3 — long-term per-job.
        void memory.writeL3({
          agent_id: args.agentObjectId,
          job_id: args.jobNonce,
          text: `Paid call complete: ${summary}`,
        }).catch(safeWarn('mode-a:writeL3_failed'));

        // L4 per-buyer — relationship slot (the warm-context source).
        void memory.writeL4PerBuyer({
          agent_id: args.agentObjectId,
          buyer_addr: args.buyerAddress,
          text: `Buyer paid call: ${summary}`,
          classify: baseClassify,
        }).catch(safeWarn('mode-a:writeL4PerBuyer_failed'));

        // L5 per-buyer — per-call critique.
        void memory.writeL5PerBuyer({
          agent_id: args.agentObjectId,
          buyer_addr: args.buyerAddress,
          text: `Per-call critique: ${runnerMemoryMs}ms · attested=${inf.attestation.verified}`,
        }).catch(safeWarn('mode-a:writeL5PerBuyer_failed'));

        // L4 agent (anonymized) — feeds the agent's general craft brain.
        void memory.writeL4Agent({
          agent_id: args.agentObjectId,
          text: `Anonymized paid-call: area=${args.manifest.area_slug ?? 'unfiled'} duration=${runnerMemoryMs}ms`,
          classify: { ...baseClassify, is_repeat_buyer_in_area: false },
        }).catch(safeWarn('mode-a:writeL4Agent_failed'));
      });
    }

    return {
      responseWalrusBlobId,
      sealedResponseKey,
      responseIv: enc.iv,
      responseDigestSha256: digest,
      attestation: inf.attestation,
      runnerMemoryMs,
    };
  }

  /** Step 2 — pull cleartext into runner memory (≤30s window). */
  private async resolveUserText(
    args: InvokeAgentInputs,
    log: (event: string, fields?: Record<string, unknown>) => void,
  ): Promise<string> {
    if (args.inputs.text && args.inputs.text.length > 0) return args.inputs.text;
    if (!args.inputs.walrus_blob_id || !args.inputs.sealed_aes_key || !args.inputs.iv) {
      return '';
    }
    log('loop:invoke:walrus_fetch', { blob_id: args.inputs.walrus_blob_id });
    const ciphertext = await this.deps.walrus.fetch(args.inputs.walrus_blob_id);

    // Seal threshold-servers verify the on-chain `seal_approve_runner_decrypt`
    // Move guard before releasing key shares; the seal client below abstracts
    // that handshake. Mock seal just XORs identity-keyed.
    const identity = loopPolicyIdentity({
      agentObjectId: args.agentObjectId,
      jobNonce: args.jobNonce,
      buyerAddr: args.buyerAddress,
    });
    const aesKey = await this.deps.seal.decryptKey({
      identity,
      ciphertext: args.inputs.sealed_aes_key,
    });
    const { aesGcmDecrypt } = await import('@fhe-ai-context/sdk');
    const plain = await aesGcmDecrypt({ ciphertext, key: aesKey, iv: args.inputs.iv });
    return new TextDecoder('utf-8', { fatal: false }).decode(plain);
  }
}

/**
 * Splice warm-context recall hits into the persona system prompt.
 *
 * Format mimics the Mode B dispatcher (`dispatcher:warm_context_loaded` log).
 * Per-buyer hits come first (most actionable for repeat buyers); general
 * craft hits second. Total recall block is hard-capped to keep prompt token
 * usage predictable. SOLID-SRP: one tiny pure function — easy to test.
 */
function augmentSystemPrompt(
  basePrompt: string,
  warm: WarmContextResult | null,
): string {
  if (!warm) return basePrompt;
  const perBuyer = warm.per_buyer.slice(0, 3);
  const general = warm.agent_general.slice(0, 3);
  if (!perBuyer.length && !general.length) return basePrompt;
  const lines: string[] = ['', '---', 'Warm context recalled from prior runs:'];
  perBuyer.forEach((h, i) => lines.push(`[buyer-${i}] ${h.text.slice(0, 300)}`));
  general.forEach((h, i) => lines.push(`[general-${i}] ${h.text.slice(0, 200)}`));
  lines.push('---', '');
  return `${basePrompt}\n${lines.join('\n')}`;
}
