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

const RUNNER_MEM_SOFT_LIMIT_MS = 30_000;

export interface AgentManifest {
  title: string;
  persona_system_prompt: string;
  default_model_id?: string;
  word_limit?: number;
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

    // 4. Phala TEE inference.
    log('loop:invoke:phala');
    const inf = await this.deps.phala.infer([
      { role: 'system', content: args.manifest.persona_system_prompt },
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
