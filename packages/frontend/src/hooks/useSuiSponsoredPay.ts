'use client';

/**
 * useSuiSponsoredPay — Mode A x402 dance for the loop product.
 *
 * Steps owned here:
 *   1. POST /v3/loop/agents/:id/invoke (no X-PAYMENT) → 402 + ptb_bytes_b64 + challenge_id
 *   2. dapp-kit signs the PTB bytes (one popup)
 *   3. POST again with X-PAYMENT = base64({ ptb_bytes_b64, buyer_signature, challenge_id })
 *   4. Return { tx_digest, response_walrus_blob_id, sealed_response_key_b64, response_iv_b64, attestation }
 *
 * SOLID:
 *   - SRP: hook owns the protocol; UI owns rendering; service layer owns
 *     server-side settlement.
 *   - DIP: AGENT_BACKEND_URL injected via lib/api.ts (no hard-coded URL).
 */

import { useCallback, useState } from 'react';
import { useCurrentAccount, useSignTransaction } from '@mysten/dapp-kit';
import { AGENT_BACKEND_URL } from '@/lib/api';

export interface SuiSponsoredPayResult {
  tx_digest: string;
  response_walrus_blob_id: string;
  sealed_response_key_b64: string;
  response_iv_b64: string;
  response_digest_sha256: string;
  attestation: { provider: string; quote: string; verified: boolean; issuedAt: string };
  runner_memory_ms: number;
}

export interface PayAndRunArgs {
  agentObjectId: string;
  /** Buyer-owned `Coin<USDC>` object id with at least `agent.per_iter_default` value. */
  paymentCoinObjectId: string;
  /** Inline text input. */
  text?: string;
  /** OR Walrus-blob input (encrypted). */
  walrusBlobId?: string;
  sealedAesKey?: Uint8Array;
  iv?: Uint8Array;
  /** Optional override (defaults to agent manifest default). */
  personaSystemPrompt?: string;
  wordLimit?: number;
}

export function useSuiSponsoredPay() {
  const account = useCurrentAccount();
  const { mutateAsync: signTransaction } = useSignTransaction();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const payAndRun = useCallback(
    async (args: PayAndRunArgs): Promise<SuiSponsoredPayResult> => {
      if (!account?.address) throw new Error('connect a Sui wallet first');
      setBusy(true);
      setError(null);
      try {
        // Step 1 — request 402 challenge envelope.
        const challenge = await fetch(`${AGENT_BACKEND_URL}/v3/loop/agents/${args.agentObjectId}/invoke`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-wallet-address': account.address },
          body: JSON.stringify({
            buyer_address: account.address,
            payment_coin_object_id: args.paymentCoinObjectId,
            text: args.text,
            walrus_blob_id: args.walrusBlobId,
            sealed_aes_key: args.sealedAesKey ? bufToB64(args.sealedAesKey) : undefined,
            iv: args.iv ? bufToB64(args.iv) : undefined,
            persona_system_prompt: args.personaSystemPrompt,
            word_limit: args.wordLimit,
          }),
        });
        if (challenge.status !== 402) throw new Error(`expected 402, got ${challenge.status}`);
        const env = (await challenge.json()) as {
          ptb_bytes_b64: string;
          challenge_id: string;
        };

        // Step 2 — sign the PTB bytes with dapp-kit (accept b64 string directly).
        const signed = await signTransaction({
          transaction: env.ptb_bytes_b64,
        } as unknown as Parameters<typeof signTransaction>[0]);

        // Step 3 — re-POST with X-PAYMENT.
        const xPayment = btoa(
          JSON.stringify({
            ptb_bytes_b64: env.ptb_bytes_b64,
            buyer_signature: signed.signature,
            challenge_id: env.challenge_id,
          }),
        );
        const final = await fetch(`${AGENT_BACKEND_URL}/v3/loop/agents/${args.agentObjectId}/invoke`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-wallet-address': account.address,
            'X-PAYMENT': xPayment,
          },
          body: JSON.stringify({
            buyer_address: account.address,
            payment_coin_object_id: args.paymentCoinObjectId,
            text: args.text,
            walrus_blob_id: args.walrusBlobId,
            sealed_aes_key: args.sealedAesKey ? bufToB64(args.sealedAesKey) : undefined,
            iv: args.iv ? bufToB64(args.iv) : undefined,
            persona_system_prompt: args.personaSystemPrompt,
            word_limit: args.wordLimit,
          }),
        });
        if (!final.ok) throw new Error(`invoke failed ${final.status}: ${await final.text()}`);
        return (await final.json()) as SuiSponsoredPayResult;
      } catch (e) {
        setError((e as Error).message);
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [account?.address, signTransaction],
  );

  return { payAndRun, busy, error };
}

function bufToB64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}
