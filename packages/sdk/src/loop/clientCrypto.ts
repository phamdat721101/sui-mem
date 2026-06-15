/**
 * loop/clientCrypto — browser/Node-isomorphic primitives the loop product
 * needs on the buyer side: AES-GCM encrypt/decrypt over Web Crypto,
 * Seal-IBE key wrapping for the per-job policy, and Walrus blob upload.
 *
 * The whole file uses `globalThis.crypto.subtle` so it works under Node 20+
 * and any modern browser — no `node:crypto` import path that'd break the
 * Next.js bundler.
 *
 * SOLID:
 *   - SRP: each exported function does ONE thing; no class boilerplate.
 *   - DIP: Seal client + Walrus store are *passed in* by callers. The hook
 *     in the frontend constructs them via `createSealKeyClient()` /
 *     `createWalrusStore()` from `@openx/sui-sdk`; tests inject mocks.
 *   - LSP: `Uint8Array` everywhere — no Buffer leakage out of Node-only
 *     code paths. Hex strings are clearly typed `0x${string}`.
 */

const subtle = (): SubtleCrypto => {
  const g = (globalThis as unknown as { crypto?: { subtle?: SubtleCrypto } }).crypto;
  if (!g?.subtle) {
    throw new Error('loop:clientCrypto: globalThis.crypto.subtle missing (Node 20+ or modern browser required)');
  }
  return g.subtle;
};

const getRandomBytes = (n: number): Uint8Array => {
  const out = new Uint8Array(n);
  (globalThis as unknown as { crypto: { getRandomValues: (a: Uint8Array) => Uint8Array } })
    .crypto.getRandomValues(out);
  return out;
};

// ─── AES-GCM ─────────────────────────────────────────────────────────────

export interface AesGcmEncrypted {
  /** ciphertext ‖ 16-byte authTag (Web Crypto's standard layout). */
  ciphertext: Uint8Array;
  iv: Uint8Array;            // 12 bytes
  key: Uint8Array;            // 32 bytes
}

export async function aesGcmEncrypt(plaintext: Uint8Array): Promise<AesGcmEncrypted> {
  const key = getRandomBytes(32);
  const iv = getRandomBytes(12);
  const cryptoKey = await subtle().importKey('raw', key as BufferSource, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(
    await subtle().encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, cryptoKey, plaintext as BufferSource),
  );
  return { ciphertext: ct, iv, key };
}

export async function aesGcmDecrypt(args: {
  ciphertext: Uint8Array;
  key: Uint8Array;
  iv: Uint8Array;
}): Promise<Uint8Array> {
  if (args.key.byteLength !== 32) throw new Error('loop:aesGcm: key must be 32 bytes');
  if (args.iv.byteLength !== 12) throw new Error('loop:aesGcm: iv must be 12 bytes');
  const cryptoKey = await subtle().importKey('raw', args.key as BufferSource, 'AES-GCM', false, ['decrypt']);
  return new Uint8Array(
    await subtle().decrypt(
      { name: 'AES-GCM', iv: args.iv as BufferSource },
      cryptoKey,
      args.ciphertext as BufferSource,
    ),
  );
}

// ─── Per-job Seal-IBE policy (Q3=a: native IBE policy, no on-chain key vault) ─

/**
 * Build the IBE identity string for a Mode-A or Mode-B job. Format:
 *   `loop:agentObjectId:jobNonce:buyerAddr` (lowercased, ":" separated).
 * The Seal threshold servers derive a per-policy key from this identity;
 * the on-chain `seal_approve_*` Move guards bound which wallet can request
 * which capability.
 */
export function loopPolicyIdentity(args: {
  agentObjectId: string;
  jobNonce: string;
  buyerAddr: string;
}): string {
  return `loop:${args.agentObjectId.toLowerCase()}:${args.jobNonce.toLowerCase()}:${args.buyerAddr.toLowerCase()}`;
}

/**
 * Seal-encrypt the AES key for a per-job policy. The returned bytes are the
 * Seal IBE ciphertext that the runner — under the on-chain Move guard —
 * can ask the threshold key servers to derive a decryption capability for.
 */
export async function sealEncryptJobKey(args: {
  seal: { encryptKey: (opts: { identity: string; key: Uint8Array }) => Promise<Uint8Array> };
  aesKey: Uint8Array;
  agentObjectId: string;
  jobNonce: string;
  buyerAddr: string;
}): Promise<Uint8Array> {
  return args.seal.encryptKey({
    identity: loopPolicyIdentity({
      agentObjectId: args.agentObjectId,
      jobNonce: args.jobNonce,
      buyerAddr: args.buyerAddr,
    }),
    key: args.aesKey,
  });
}

// ─── Walrus upload helper ─────────────────────────────────────────────────

/**
 * Upload `bytes` to Walrus and return the canonical blobId. Thin wrapper
 * over the existing `@openx/sui-sdk` `WalrusStore.upload` so the loop SDK
 * doesn't fork yet another HTTP client.
 */
export async function walrusUpload(args: {
  walrus: { upload: (b: Uint8Array) => Promise<{ blobs: Array<{ blobId: string }> }> };
  bytes: Uint8Array;
}): Promise<string> {
  const r = await args.walrus.upload(args.bytes);
  if (!r.blobs.length) throw new Error('loop:walrus: upload returned no blob');
  return r.blobs[0].blobId;
}
