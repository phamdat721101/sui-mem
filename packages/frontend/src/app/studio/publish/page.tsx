'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit';
import { api, type PublishInput, type PublishResult, AGENT_BACKEND_URL } from '@/lib/api';

/**
 * /studio/publish — Sui-only publish wizard.
 *
 * Single-page form (not multi-step) — five required fields fit on one screen
 * and validation is fast enough that a wizard would be friction without
 * adding clarity. Submits to `POST /v3/marketplace/seller/publish` which is
 * atomic on the server (seller upsert + brain INSERT + agent INSERT).
 *
 * SOLID:
 *  - SRP: this file owns "render the form + ship the payload". Validation
 *    is server-side; we only echo errors.
 *  - DIP: depends on `api.publish(...)` — never on URL strings.
 *  - OCP: a new field = one input + one slot in the payload.
 */

const DOMAINS: PublishInput['domain'][] = [
  'marketing', 'finance', 'research', 'engineering', 'generalist', 'other',
];

interface FormState {
  title: string;
  short_description: string;
  long_description: string;
  domain: PublishInput['domain'];
  tags: string;
  persona_system_prompt: string;
  pricing_amount_usdc: string;
}

const INITIAL: FormState = {
  title: '',
  short_description: '',
  long_description: '',
  domain: 'generalist',
  tags: '',
  persona_system_prompt: '',
  pricing_amount_usdc: '0.01',
};

export default function PublishPage() {
  const account = useCurrentAccount();
  if (!account) {
    return (
      <div className="mx-auto max-w-xl rounded-xl border border-dashed border-outline-variant/40 bg-surface-container-low p-12 text-center">
        <h1 className="font-headline text-2xl font-bold">Connect to publish</h1>
        <p className="mt-2 text-sm text-on-surface-variant">
          Your Sui wallet signs the publish — there&apos;s no account creation step.
        </p>
      </div>
    );
  }
  return <PublishForm wallet={account.address} />;
}

function PublishForm({ wallet }: { wallet: string }) {
  const [form, setForm] = useState<FormState>(INITIAL);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<PublishResult | null>(null);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((s) => ({ ...s, [k]: v }));

  async function submit() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.publish(wallet, {
        title: form.title.trim(),
        short_description: form.short_description.trim(),
        long_description: form.long_description.trim() || undefined,
        domain: form.domain,
        tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
        persona_system_prompt: form.persona_system_prompt.trim(),
        pricing_amount_usdc: form.pricing_amount_usdc,
      });
      setResult(r);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  if (result) return <PublishSuccess result={result} />;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header>
        <Link href="/studio" className="font-mono text-xs text-on-surface-variant hover:text-primary">
          ← Studio
        </Link>
        <h1 className="mt-2 font-headline text-3xl font-bold">Publish a new agent</h1>
        <p className="text-on-surface-variant">
          Sellers earn USDC every time an agent calls. The platform never sees your knowledge in plaintext.
        </p>
      </header>

      <form
        onSubmit={(e) => { e.preventDefault(); submit(); }}
        className="space-y-5 rounded-xl border border-outline-variant/30 bg-surface p-6"
      >
        <Field label="Title" hint="3–120 chars">
          <input
            value={form.title}
            onChange={(e) => set('title', e.target.value)}
            required minLength={3} maxLength={120}
            className={inputCx}
            placeholder="Wiz Trading"
          />
        </Field>

        <Field label="Short description" hint="10–240 chars · shown on cards">
          <input
            value={form.short_description}
            onChange={(e) => set('short_description', e.target.value)}
            required minLength={10} maxLength={240}
            className={inputCx}
            placeholder="Trade signals from a quant team."
          />
        </Field>

        <Field label="Long description" hint="optional · shown on detail page">
          <textarea
            value={form.long_description}
            onChange={(e) => set('long_description', e.target.value)}
            rows={3}
            className={inputCx}
          />
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Domain">
            <select
              value={form.domain}
              onChange={(e) => set('domain', e.target.value as PublishInput['domain'])}
              className={inputCx}
            >
              {DOMAINS.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </Field>

          <Field label="Price per call" hint="USDC · paid via Sui-USDC rail">
            <input
              type="text" inputMode="decimal"
              value={form.pricing_amount_usdc}
              onChange={(e) => set('pricing_amount_usdc', e.target.value)}
              required
              className={inputCx}
              placeholder="0.01"
            />
          </Field>
        </div>

        <Field label="Tags" hint="comma-separated · up to 10">
          <input
            value={form.tags}
            onChange={(e) => set('tags', e.target.value)}
            className={inputCx}
            placeholder="trading, quant, signals"
          />
        </Field>

        <Field label="Agent system prompt" hint="≥10 chars · shown to the LLM on every call">
          <textarea
            value={form.persona_system_prompt}
            onChange={(e) => set('persona_system_prompt', e.target.value)}
            required minLength={10}
            rows={5}
            className={inputCx}
            placeholder="You are an expert trading assistant. When the user asks for a signal, return a JSON object with the symbol, side, and confidence."
          />
        </Field>

        {err && (
          <div className="rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
            {err}
          </div>
        )}

        <div className="flex items-center justify-between gap-3 border-t border-outline-variant/20 pt-4">
          <span className="font-mono text-[11px] text-on-surface-variant">
            Wallet · {wallet.slice(0, 6)}…{wallet.slice(-4)}
          </span>
          <button
            type="submit"
            disabled={busy}
            className="rounded-full bg-primary px-5 py-2 text-sm font-medium text-on-primary disabled:opacity-50"
          >
            {busy ? 'Publishing…' : 'Publish'}
          </button>
        </div>
      </form>
    </div>
  );
}

function PublishSuccess({ result }: { result: PublishResult }) {
  const url = `${AGENT_BACKEND_URL}/api/v1/${result.slug}`;
  const curl = `curl '${url}?q=hello'`;
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="rounded-xl border border-secondary/40 bg-secondary/5 p-6">
        <div className="flex items-center gap-2 text-secondary">
          <span className="material-symbols-outlined">check_circle</span>
          <h1 className="font-headline text-xl font-bold">Published</h1>
        </div>
        <p className="mt-2 text-sm text-on-surface-variant">
          Your agent is live in the marketplace. Slug: <code className="font-mono text-on-surface">{result.slug}</code>
        </p>
        <div className="mt-4 grid gap-2 text-sm">
          <Link href={`/agent/${result.slug}`} className="text-primary hover:underline">
            Open agent detail →
          </Link>
          <Link href="/studio" className="text-on-surface-variant hover:text-on-surface">
            Back to studio
          </Link>
          <Link href="/train" className="text-on-surface-variant hover:text-on-surface">
            Train its MemWal brain →
          </Link>
        </div>
      </div>

      <div className="rounded-xl border border-outline-variant/30 bg-surface p-6">
        <h2 className="font-headline text-base font-semibold">Try it</h2>
        <p className="mt-1 text-xs text-on-surface-variant">
          First call returns 402 Payment Required. The n-payment SDK settles in Sui-USDC and retries with the receipt.
        </p>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-surface-container-low p-3 font-mono text-[12px]">
          <code>{curl}</code>
        </pre>
      </div>
    </div>
  );
}

const inputCx =
  'w-full rounded-lg border border-outline-variant/40 bg-surface-container-low px-3 py-2 text-sm text-on-surface focus:border-primary/60 focus:outline-none';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-medium text-on-surface">{label}</span>
        {hint && <span className="font-mono text-[10px] text-on-surface-variant">{hint}</span>}
      </div>
      {children}
    </label>
  );
}
