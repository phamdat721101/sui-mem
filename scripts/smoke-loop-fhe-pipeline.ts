/**
 * scripts/smoke-loop-fhe-pipeline.ts — offline Walrus + Seal + AES-GCM round-trip.
 *
 * No network needed. Uses the mock SealKeyClient + mock WalrusStore (both
 * shipped in `@fhe-ai-context/sui-sdk` when no env URLs are set). Verifies:
 *   1. AES-GCM encrypt + decrypt is byte-identical.
 *   2. Seal-IBE wraps + unwraps the AES key under the per-job policy.
 *   3. Walrus blob round-trip preserves bytes.
 *   4. The whole pipeline finishes well under the 30-second cleartext SLO.
 *
 * Run:  npm run smoke:loop-fhe-pipeline
 */

import {
  aesGcmEncrypt,
  aesGcmDecrypt,
  loopPolicyIdentity,
} from '@fhe-ai-context/sdk';
import { createSealKeyClient, createWalrusStore } from '@fhe-ai-context/sui-sdk';

async function main() {
  const t0 = Date.now();
  console.log('smoke-loop-fhe-pipeline (offline mock stack)');

  const seal = createSealKeyClient();        // mock — no SEAL_KEY_SERVERS env
  const walrus = createWalrusStore();        // mock — no WALRUS_PUBLISHER_URL env

  const buyer = '0x' + 'a'.repeat(64);
  const agent = '0x' + 'b'.repeat(64);
  const jobNonce = 'test-nonce-001';
  const identity = loopPolicyIdentity({ agentObjectId: agent, jobNonce, buyerAddr: buyer });

  // 1. Encrypt some plaintext.
  const original = new TextEncoder().encode('Translate this NDA section to Vietnamese: …');
  const enc = await aesGcmEncrypt(original);
  if (enc.key.byteLength !== 32) throw new Error('aes key wrong size');
  if (enc.iv.byteLength !== 12) throw new Error('iv wrong size');

  // 2. Walrus round-trip.
  const upload = await walrus.upload(enc.ciphertext);
  if (upload.blobs.length === 0) throw new Error('walrus upload empty');
  const fetched = await walrus.fetch(upload.blobs[0].blobId);
  if (fetched.byteLength !== enc.ciphertext.byteLength) throw new Error('walrus byte mismatch');

  // 3. Seal wrap + unwrap the AES key under the per-job policy.
  const sealed = await seal.encryptKey({ identity, key: enc.key });
  const unwrapped = await seal.decryptKey({ identity, ciphertext: sealed });
  if (unwrapped.byteLength !== 32) throw new Error('seal unwrap wrong size');
  for (let i = 0; i < 32; i++) {
    if (unwrapped[i] !== enc.key[i]) throw new Error(`seal unwrap byte ${i} mismatch`);
  }

  // 4. AES-GCM decrypt → original bytes.
  const decrypted = await aesGcmDecrypt({ ciphertext: fetched, key: unwrapped, iv: enc.iv });
  if (decrypted.byteLength !== original.byteLength) throw new Error('plaintext length mismatch');
  for (let i = 0; i < original.byteLength; i++) {
    if (decrypted[i] !== original[i]) throw new Error(`plaintext byte ${i} mismatch`);
  }

  const ms = Date.now() - t0;
  if (ms > 30_000) throw new Error(`SLO breach: pipeline took ${ms}ms (>30s)`);
  console.log(`✅ smoke-loop-fhe-pipeline passed in ${ms}ms`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
