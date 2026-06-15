'use client';

/**
 * useSealJobResults — buyer-side decryption of a per-iter encrypted response.
 *
 * Derives a Seal decryption capability under the per-job IBE policy
 * `(agent_id, job_nonce, buyer_addr)` (matches the Move guard
 * `seal_approve_buyer_iter_decrypt` for Mode B and
 * `seal_approve_buyer_decrypt` for Mode A). Caches the session in
 * `sessionStorage` keyed by job_nonce so a buyer doesn't have to sign N
 * times for N iters in the same session.
 *
 * SOLID:
 *   - SRP: Seal handshake + Walrus fetch + AES decrypt only. UI owns rendering.
 *   - DIP: createSealKeyClient + createWalrusStore are factory-injected;
 *     tests can override via the optional `seal` / `walrus` args.
 */

import { useCallback, useState } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit';
import { aesGcmDecrypt, loopPolicyIdentity } from '@fhe-ai-context/sdk';
import {
  createSealKeyClient,
  createWalrusStore,
  type SealKeyClient,
  type WalrusStore,
} from '@fhe-ai-context/sui-sdk';

export interface DecryptArgs {
  agentObjectId: string;
  jobNonce: string;
  walrusBlobId: string;
  sealedResponseKey: Uint8Array;
  iv: Uint8Array;
  /** Optional dependency injection for tests. */
  seal?: SealKeyClient;
  walrus?: WalrusStore;
}

const SESSION_PREFIX = 'openx-loop-seal-cap:';

export function useSealJobResults() {
  const account = useCurrentAccount();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decrypt = useCallback(
    async (args: DecryptArgs): Promise<string> => {
      if (!account?.address) throw new Error('connect a Sui wallet first');
      setBusy(true);
      setError(null);
      try {
        const seal = args.seal ?? createSealKeyClient();
        const walrus = args.walrus ?? createWalrusStore();
        const identity = loopPolicyIdentity({
          agentObjectId: args.agentObjectId,
          jobNonce: args.jobNonce,
          buyerAddr: account.address,
        });

        // Step 1 — Seal threshold servers derive the per-policy key.
        // (Mock seal: instant; production: prompts a wallet sig if not cached.)
        const cacheKey = SESSION_PREFIX + args.jobNonce;
        const cachedB64 = typeof window !== 'undefined' ? sessionStorage.getItem(cacheKey) : null;
        let aesKey: Uint8Array;
        if (cachedB64) {
          aesKey = Uint8Array.from(atob(cachedB64), (c) => c.charCodeAt(0));
        } else {
          aesKey = await seal.decryptKey({ identity, ciphertext: args.sealedResponseKey });
          if (typeof window !== 'undefined') {
            let s = '';
            for (let i = 0; i < aesKey.length; i++) s += String.fromCharCode(aesKey[i]);
            sessionStorage.setItem(cacheKey, btoa(s));
          }
        }

        // Step 2 — Walrus-fetch the ciphertext.
        const ciphertext = await walrus.fetch(args.walrusBlobId);

        // Step 3 — AES-GCM decrypt.
        const plain = await aesGcmDecrypt({ ciphertext, key: aesKey, iv: args.iv });
        return new TextDecoder('utf-8', { fatal: false }).decode(plain);
      } catch (e) {
        setError((e as Error).message);
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [account?.address],
  );

  return { decrypt, busy, error };
}
