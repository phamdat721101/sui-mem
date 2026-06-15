'use client';

/**
 * /loop/seller/onboard — single-page seller wizard for OpenX Loops.
 *
 * Steps owned in this single component:
 *   1. Fill manifest fields (title, persona prompt, per-iter price, max iter, splits).
 *   2. Upload manifest YAML to Walrus (stub: posted as a single Walrus put through the API).
 *      For v0.0 simplicity we let the server build the PTB without uploading the
 *      manifest YAML separately — the persona is included in the on-chain
 *      manifest_walrus_blob_id field. A v0.1 pass adds proper Walrus upload.
 *   3. Server returns ptb_bytes_b64. Wallet signs.
 *   4. Server submits as sponsor — buyer pays no gas.
 *
 * SOLID:
 *   - SRP: form + 4-step orchestration. Cryptographic primitives live in the SDK.
 */

import { useState } from 'react';
import { useCurrentAccount, useSignTransaction } from '@mysten/dapp-kit';
import { AGENT_BACKEND_URL } from '@/lib/api';

interface FormState {
  title: string;
  short_description: string;
  persona_system_prompt: string;
  per_iter_default_micro_usdc: number;
  max_iter_per_job: number;
  manifest_walrus_blob_id: string;
}

const DEFAULTS: FormState = {
  title: '',
  short_description: '',
  persona_system_prompt: '',
  per_iter_default_micro_usdc: 50_000, // $0.05
  max_iter_per_job: 10,
  manifest_walrus_blob_id: '',
};

export default function LoopSellerOnboardPage() {
  const account = useCurrentAccount();
  const { mutateAsync: signTransaction } = useSignTransaction();
  const [f, setF] = useState<FormState>(DEFAULTS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ tx_digest: string; agent_object_id: string } | null>(null);

  const update = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));

  const submit = async () => {
    if (!account?.address) {
      setError('Connect a Sui wallet first');
      return;
    }
    if (!f.title || !f.persona_system_prompt) {
      setError('title and persona_system_prompt required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const manifestBlobId =
        f.manifest_walrus_blob_id || `walrus-stub-${Date.now()}-${account.address.slice(2, 10)}`;

      // Step 1 — server builds PTB.
      const build = await fetch(`${AGENT_BACKEND_URL}/v3/loop/seller/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-wallet-address': account.address },
        body: JSON.stringify({
          manifest_walrus_blob_id: manifestBlobId,
          persona_system_prompt: f.persona_system_prompt,
          title: f.title,
          short_description: f.short_description,
          per_iter_default_micro_usdc: f.per_iter_default_micro_usdc,
          max_iter_per_job: f.max_iter_per_job,
        }),
      });
      if (!build.ok) throw new Error(`build failed: ${build.status} ${await build.text()}`);
      const { ptb_bytes_b64 } = (await build.json()) as { ptb_bytes_b64: string };
      const ptbBytes = Uint8Array.from(atob(ptb_bytes_b64), (c) => c.charCodeAt(0));

      // Step 2 — wallet signs (b64 string accepted by dapp-kit).
      const signed = await signTransaction({
        transaction: ptb_bytes_b64,
      } as unknown as Parameters<typeof signTransaction>[0]);

      // Step 3 — server submits as sponsor.
      const submit = await fetch(`${AGENT_BACKEND_URL}/v3/loop/seller/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-wallet-address': account.address },
        body: JSON.stringify({
          manifest_walrus_blob_id: manifestBlobId,
          persona_system_prompt: f.persona_system_prompt,
          title: f.title,
          short_description: f.short_description,
          per_iter_default_micro_usdc: f.per_iter_default_micro_usdc,
          max_iter_per_job: f.max_iter_per_job,
          signed_ptb_bytes_b64: ptb_bytes_b64,
          buyer_signature: signed.signature,
        }),
      });
      if (!submit.ok) throw new Error(`submit failed: ${submit.status} ${await submit.text()}`);
      const r = (await submit.json()) as { tx_digest: string; agent_object_id: string };
      setResult(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header className="space-y-2">
        <h1 className="font-headline text-3xl font-bold">Publish a loop agent</h1>
        <p className="text-on-surface-variant">
          One signature → on-chain Agent shared object. We pay your gas (Sui sponsored tx).
        </p>
      </header>

      <div className="space-y-4 rounded-xl border border-outline-variant/30 bg-surface p-5">
        <Field label="Title">
          <input
            value={f.title}
            onChange={(e) => update('title', e.target.value)}
            placeholder="EN→VI legal translator"
            className="w-full rounded-md bg-surface-container-low px-3 py-2 text-on-surface focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </Field>
        <Field label="Short description">
          <input
            value={f.short_description}
            onChange={(e) => update('short_description', e.target.value)}
            placeholder="Translate any English contract to Vietnamese, preserves clause numbering."
            className="w-full rounded-md bg-surface-container-low px-3 py-2 text-on-surface focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </Field>
        <Field label="Persona system prompt">
          <textarea
            rows={5}
            value={f.persona_system_prompt}
            onChange={(e) => update('persona_system_prompt', e.target.value)}
            placeholder="You are a precise English→Vietnamese legal translator. Preserve clause numbers and definitions."
            className="w-full rounded-md bg-surface-container-low px-3 py-2 text-on-surface focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Price per iter (µUSDC)">
            <input
              type="number"
              value={f.per_iter_default_micro_usdc}
              onChange={(e) => update('per_iter_default_micro_usdc', Number(e.target.value))}
              className="w-full rounded-md bg-surface-container-low px-3 py-2 text-on-surface focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </Field>
          <Field label="Max iter per hire">
            <input
              type="number"
              min={1}
              max={50}
              value={f.max_iter_per_job}
              onChange={(e) => update('max_iter_per_job', Number(e.target.value))}
              className="w-full rounded-md bg-surface-container-low px-3 py-2 text-on-surface focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </Field>
        </div>
      </div>

      <button
        type="button"
        onClick={submit}
        disabled={busy || !account?.address}
        className="w-full rounded-full bg-primary py-2.5 font-mono text-sm text-on-primary disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? 'Publishing…' : 'Publish (sponsored)'}
      </button>

      {error && <div className="rounded-lg border border-error/40 bg-error/10 p-3 text-sm text-error">{error}</div>}
      {result && (
        <div className="rounded-lg border border-primary/40 bg-primary/10 p-3 text-sm text-primary">
          ✓ Published. Agent: <span className="font-mono">{result.agent_object_id}</span>
          <br />
          Tx: <span className="font-mono">{result.tx_digest}</span>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-mono uppercase text-on-surface-variant">{label}</span>
      {children}
    </label>
  );
}
