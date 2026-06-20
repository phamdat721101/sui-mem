'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  useCurrentAccount,
  useSuiClient,
  useSignAndExecuteTransaction,
} from '@mysten/dapp-kit';
import { api, type PublishInput, type PublishResult, AGENT_BACKEND_URL } from '@/lib/api';
import {
  type BedrockTier,
  defaultModelIdForTier,
  modelsByTier,
} from '@fhe-ai-context/sui-sdk';
import { buildPublishAgentWithFeePtb } from '@fhe-ai-context/sdk';

/**
 * /studio/publish — on-chain seller publish wizard (PRD-W v1.3).
 *
 * Two paths gated by V2 config:
 *   - V2 (FEATURE_LOOP_SELLER_V2=true on BE): single PTB → Walrus upload +
 *     Agent shared-object creation + atomic $1 USDC transfer to admin +
 *     Bedrock model whitelist enforcement. Postgres mirror via /seller/publish.
 *   - Legacy: Postgres-only `api.publish()` (preserved for rollback).
 *
 * SOLID:
 *  - SRP: presentation + tx orchestration. Validation lives BE-side.
 *  - DIP: every external surface (Walrus URL, package id, USDC type, admin
 *    addr) comes from `api.getSellerV2Config()` — no hard-coded chain ids.
 */

const DOMAINS: PublishInput['domain'][] = [
  'marketing', 'finance', 'research', 'engineering', 'generalist', 'other',
];

const WALRUS_PUBLISHER =
  process.env.NEXT_PUBLIC_WALRUS_PUBLISHER_URL ?? 'https://publisher.walrus-testnet.walrus.space';

interface FormState {
  title: string;
  short_description: string;
  long_description: string;
  domain: PublishInput['domain'];
  tags: string;
  persona_system_prompt: string;
  pricing_amount_usdc: string;
  tier: BedrockTier;
  model_id: string;
  /** PRD-X2 — agent kind. 'workflow' adds 1 extra field (area_slugs);
   *  workflow_walrus_blob_id is auto-pinned at submit. */
  kind: 'api' | 'workflow';
  area_slugs: string;
}

const INITIAL: FormState = {
  title: '',
  short_description: '',
  long_description: '',
  domain: 'generalist',
  tags: '',
  persona_system_prompt: '',
  pricing_amount_usdc: '0.01',
  tier: 'balanced',
  model_id: defaultModelIdForTier('balanced'),
  kind: 'api',
  area_slugs: '',
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
  const client = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const [form, setForm] = useState<FormState>(INITIAL);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<PublishResult | null>(null);
  const [v2Config, setV2Config] = useState<Awaited<ReturnType<typeof api.getSellerV2Config>> | null>(null);

  useEffect(() => {
    api.getSellerV2Config().then(setV2Config).catch(() => setV2Config(null));
  }, []);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((s) => ({ ...s, [k]: v }));

  const v2Ready = !!(v2Config?.enabled && v2Config.package_id && v2Config.bedrock_registry_id && v2Config.admin_addr && v2Config.usdc_coin_type);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    setStatus(null);
    try {
      if (v2Ready && v2Config) {
        await submitOnChain(v2Config);
      } else {
        await submitLegacy();
      }
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
      setStatus(null);
    }
  }

  async function submitLegacy() {
    setStatus('Saving to catalog…');
    const areas = form.kind === 'workflow'
      ? form.area_slugs.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 16)
      : undefined;
    // PRD-X2 — for kind=workflow we need a Walrus blob id. Pin a minimal
    // workflow skeleton manifest at publish time; the seller's full YAML
    // edit happens later via /agent/[id]/workflow.
    let workflowBlobId: string | undefined;
    if (form.kind === 'workflow') {
      setStatus('Pinning workflow skeleton to Walrus…');
      const skeleton = buildWorkflowSkeleton(form);
      workflowBlobId = await publishToWalrus(skeleton).catch(() => undefined);
      if (!workflowBlobId) {
        // Walrus unavailable in some envs; fall back to a deterministic
        // placeholder so the legacy publish path still records kind=workflow
        // (operator/back-fill cron can re-pin later).
        workflowBlobId = 'workflow-skeleton-pending';
      }
    }
    const r = await api.publish(wallet, {
      title: form.title.trim(),
      short_description: form.short_description.trim(),
      long_description: form.long_description.trim() || undefined,
      domain: form.domain,
      tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
      persona_system_prompt: form.persona_system_prompt.trim(),
      pricing_amount_usdc: form.pricing_amount_usdc,
      kind: form.kind,
      workflow_walrus_blob_id: workflowBlobId,
      area_slugs: areas,
    });
    setResult(r);
  }

  async function submitOnChain(cfg: NonNullable<typeof v2Config>) {
    // 1. Build manifest YAML and pin to Walrus.
    setStatus('Pinning manifest to Walrus…');
    const manifestYaml = buildManifestYaml(form, wallet);
    const walrusBlobId = await publishToWalrus(manifestYaml);

    // 2. Find a USDC coin large enough to cover $1.
    setStatus('Locating USDC coin…');
    const coins = await client.getCoins({ owner: wallet, coinType: cfg.usdc_coin_type!, limit: 30 });
    const fundedCoin = coins.data.find((c) => Number(c.balance) >= cfg.publish_fee_micro);
    if (!fundedCoin) {
      throw new Error(`Need ≥ $${cfg.publish_fee_micro / 1e6} USDC. Get testnet USDC and try again.`);
    }

    // 3. Build the PTB.
    const tx = buildPublishAgentWithFeePtb({
      packageId: cfg.package_id!,
      bedrockRegistryObjectId: cfg.bedrock_registry_id!,
      feeCoinObjectId: fundedCoin.coinObjectId,
      adminAddr: cfg.admin_addr!,
      feeUsdcType: cfg.usdc_coin_type!,
      manifestWalrusBlobId: walrusBlobId,
      defaultInferenceBackend: 'phala-tee',
      defaultModelId: form.model_id,
      perIterMinMicroUsdc: BigInt(Math.floor(Number(form.pricing_amount_usdc) * 1_000_000)),
      perIterDefaultMicroUsdc: BigInt(Math.floor(Number(form.pricing_amount_usdc) * 1_000_000)),
      maxIterPerJob: 10,
    });

    // 4. Sign + execute.
    setStatus('Awaiting wallet signature…');
    const signed = await signAndExecute({
      transaction: tx as unknown as Parameters<typeof signAndExecute>[0]['transaction'],
    });

    // 5. Wait for indexing on the fullnode.
    setStatus('Confirming on-chain…');
    try { await client.waitForTransaction({ digest: signed.digest, timeout: 20_000 }); } catch { /* non-fatal */ }

    // 6. Mirror to Postgres via existing /v3/marketplace/seller/publish.
    setStatus('Saving to catalog…');
    // Workflow path: pin a skeleton blob too. The Bedrock-validated v2
    // PTB uses `manifestWalrusBlobId` for the agent record; the workflow
    // blob is a separate pin consumed by the upgrade init_extension PTB.
    let workflowBlobId: string | undefined;
    let areas: string[] | undefined;
    if (form.kind === 'workflow') {
      const skel = buildWorkflowSkeleton(form);
      workflowBlobId = await publishToWalrus(skel).catch(() => 'workflow-skeleton-pending');
      areas = form.area_slugs.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 16);
    }
    const r = await api.publish(wallet, {
      title: form.title.trim(),
      short_description: form.short_description.trim(),
      long_description: form.long_description.trim() || undefined,
      domain: form.domain,
      tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
      persona_system_prompt: form.persona_system_prompt.trim(),
      pricing_amount_usdc: form.pricing_amount_usdc,
      kind: form.kind,
      workflow_walrus_blob_id: workflowBlobId,
      area_slugs: areas,
      // Server validates via BEDROCK_MODEL_CATALOG and stores fee_tx_digest.
      default_model_id: form.model_id,
      fee_tx_digest: signed.digest,
    } as PublishInput & { default_model_id: string; fee_tx_digest: string });
    setResult(r);
  }

  if (result) return <PublishSuccess result={result} />;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header>
        <Link href="/studio" className="font-mono text-xs text-on-surface-variant hover:text-primary">← Studio</Link>
        <h1 className="mt-2 font-headline text-3xl font-bold">Publish a new agent</h1>
        <p className="text-on-surface-variant">
          Sellers earn USDC every time an agent calls. The platform never sees your knowledge in plaintext.
        </p>
        {v2Ready ? (
          <span className="mt-2 inline-block rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-0.5 font-mono text-[10px] text-emerald-300">
            on-chain publish · $1 USDC fee · Bedrock-validated model
          </span>
        ) : (
          <span className="mt-2 inline-block rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-0.5 font-mono text-[10px] text-amber-300">
            legacy publish (off-chain)
          </span>
        )}
      </header>

      <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="space-y-5 rounded-xl border border-outline-variant/30 bg-surface p-6">
        {/* PRD-X2 / T5 — kind selector. 'api' (default) preserves the legacy
            single-form publish; 'workflow' surfaces the area_slugs field +
            pins a workflow skeleton at submit. 'skill' deferred per PRD-15. */}
        <div className="space-y-2">
          <span className="font-mono text-[10px] uppercase text-on-surface-variant">Agent kind</span>
          <div className="flex flex-wrap gap-2">
            {(['api', 'workflow'] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => set('kind', k)}
                className={`rounded-full border px-4 py-1.5 font-mono text-xs ${form.kind === k ? 'border-primary bg-primary/15 text-primary' : 'border-outline-variant/40 text-on-surface-variant hover:bg-surface-container'}`}
              >
                {k === 'api' ? 'API · paid per call' : 'Workflow · paid per outcome'}
              </button>
            ))}
            <button type="button" disabled className="rounded-full border border-outline-variant/30 px-4 py-1.5 font-mono text-xs text-on-surface-variant/50">
              Skill (soon)
            </button>
          </div>
        </div>

        <Field label="Title" hint="3–120 chars">
          <input value={form.title} onChange={(e) => set('title', e.target.value)} required minLength={3} maxLength={120} className={inputCx} placeholder="Wiz Trading" />
        </Field>

        <Field label="Short description" hint="10–240 chars">
          <input value={form.short_description} onChange={(e) => set('short_description', e.target.value)} required minLength={10} maxLength={240} className={inputCx} placeholder="Trade signals from a quant team." />
        </Field>

        <Field label="Long description" hint="optional">
          <textarea value={form.long_description} onChange={(e) => set('long_description', e.target.value)} rows={3} className={inputCx} />
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Domain">
            <select value={form.domain} onChange={(e) => set('domain', e.target.value as PublishInput['domain'])} className={inputCx}>
              {DOMAINS.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </Field>

          <Field label="Price per call (USDC)">
            <input type="text" inputMode="decimal" value={form.pricing_amount_usdc} onChange={(e) => set('pricing_amount_usdc', e.target.value)} required className={inputCx} placeholder="0.01" />
          </Field>
        </div>

        <Field label="Tags" hint="comma-separated · up to 10">
          <input value={form.tags} onChange={(e) => set('tags', e.target.value)} className={inputCx} placeholder="trading, quant, signals" />
        </Field>

        {form.kind === 'workflow' && (
          <Field
            label="PARA areas"
            hint="comma-separated · 1–16 · ongoing concerns this agent specialises in"
          >
            <input
              value={form.area_slugs}
              onChange={(e) => set('area_slugs', e.target.value)}
              className={inputCx}
              placeholder="vietnam-ev, twitter-thread-tone, weekly-research-brief"
              required
              minLength={1}
            />
          </Field>
        )}

        {v2Ready && (
          <div className="space-y-2">
            <span className="font-mono text-[10px] uppercase text-on-surface-variant">Bedrock model · pick a tier</span>
            <div className="flex flex-wrap gap-2">
              {(['fast', 'balanced', 'premium', 'long-context'] as BedrockTier[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => { set('tier', t); set('model_id', defaultModelIdForTier(t)); }}
                  className={`rounded-full border px-3 py-1 font-mono text-xs ${form.tier === t ? 'border-primary bg-primary/15 text-primary' : 'border-outline-variant/40 text-on-surface-variant hover:bg-surface-container'}`}
                >
                  {t}
                </button>
              ))}
            </div>
            <select value={form.model_id} onChange={(e) => set('model_id', e.target.value)} className={inputCx}>
              {modelsByTier(form.tier).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} · ${m.in_per_1m_usd}/M in · ${m.out_per_1m_usd}/M out · {(m.ctx_tokens / 1000).toFixed(0)}k ctx
                </option>
              ))}
            </select>
            <p className="font-mono text-[10px] text-on-surface-variant">
              Validated against the on-chain BedrockModelRegistry whitelist on submit.
            </p>
          </div>
        )}

        <Field label="Agent system prompt" hint="≥10 chars · shown to the LLM on every call">
          <textarea value={form.persona_system_prompt} onChange={(e) => set('persona_system_prompt', e.target.value)} required minLength={10} rows={5} className={inputCx} />
        </Field>

        {v2Ready && v2Config && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
            <h3 className="font-mono text-[10px] uppercase text-amber-300">Step · Pay publish fee</h3>
            <p className="mt-1 text-xs text-on-surface-variant">
              <strong>$1.00 USDC</strong> will be transferred to admin{' '}
              <code className="font-mono text-[10px]">{v2Config.admin_addr?.slice(0, 12)}…{v2Config.admin_addr?.slice(-6)}</code>{' '}
              atomically with agent creation. Single signature; if any step fails, no fee is charged.
            </p>
          </div>
        )}

        {err && <div className="rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">{err}</div>}
        {status && <div className="rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-primary">{status}</div>}

        <div className="flex items-center justify-between gap-3 border-t border-outline-variant/20 pt-4">
          <span className="font-mono text-[11px] text-on-surface-variant">
            Wallet · {wallet.slice(0, 6)}…{wallet.slice(-4)}
          </span>
          <button type="submit" disabled={busy} className="rounded-full bg-primary px-5 py-2 text-sm font-medium text-on-primary disabled:opacity-50">
            {busy ? (status ?? 'Publishing…') : v2Ready ? 'Publish + pay $1 USDC' : 'Publish'}
          </button>
        </div>
      </form>
    </div>
  );
}

function PublishSuccess({ result }: { result: PublishResult }) {
  const url = `${AGENT_BACKEND_URL}/api/v1/${result.slug}`;
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="rounded-xl border border-secondary/40 bg-secondary/5 p-6">
        <div className="flex items-center gap-2 text-secondary">
          <span className="material-symbols-outlined">check_circle</span>
          <h1 className="font-headline text-xl font-bold">Published</h1>
        </div>
        <p className="mt-2 text-sm text-on-surface-variant">
          Agent live at slug <code className="font-mono text-on-surface">{result.slug}</code>.
        </p>
        <div className="mt-4 grid gap-2 text-sm">
          <Link href={`/studio/agents/${result.slug}/activity`} className="text-primary hover:underline">
            View on-chain activity →
          </Link>
          <Link href={`/agent/${result.slug}`} className="text-primary hover:underline">
            Open agent detail →
          </Link>
          <Link href="/studio/dashboard" className="text-on-surface-variant hover:text-on-surface">
            Back to dashboard
          </Link>
        </div>
      </div>
      <div className="rounded-xl border border-outline-variant/30 bg-surface p-6">
        <h2 className="font-headline text-base font-semibold">Try it</h2>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-surface-container-low p-3 font-mono text-[12px]">
          <code>curl &apos;{url}?q=hello&apos;</code>
        </pre>
      </div>
    </div>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────

function buildManifestYaml(form: FormState, wallet: string): string {
  const tags = (form.tags.split(',').map((t) => t.trim()).filter(Boolean)).map((t) => `'${t.replace(/'/g, '')}'`).join(', ');
  return [
    `manifest_version: '1.0'`,
    `listing:`,
    `  title: ${JSON.stringify(form.title)}`,
    `  short: ${JSON.stringify(form.short_description)}`,
    `  domain: ${form.domain}`,
    `  tags: [${tags}]`,
    `owner:`,
    `  wallet_address: '${wallet}'`,
    `bedrock:`,
    `  tier: ${form.tier}`,
    `  model_id: ${JSON.stringify(form.model_id)}`,
    `pricing:`,
    `  amount_usdc: '${form.pricing_amount_usdc}'`,
    `persona:`,
    `  system_prompt: ${JSON.stringify(form.persona_system_prompt)}`,
    ``,
  ].join('\n');
}

async function publishToWalrus(yaml: string): Promise<string> {
  const r = await fetch(`${WALRUS_PUBLISHER}/v1/blobs?epochs=10`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: yaml,
  });
  if (!r.ok) throw new Error(`walrus PUT ${r.status}`);
  const j = await r.json() as { newlyCreated?: { blobObject?: { blobId?: string } }; alreadyCertified?: { blobId?: string } };
  const blobId = j.newlyCreated?.blobObject?.blobId ?? j.alreadyCertified?.blobId;
  if (!blobId) throw new Error('walrus PUT: missing blobId');
  return blobId;
}

/** PRD-X2 — minimal v1.1 workflow skeleton pinned at publish time so kind=workflow
 *  agents can be created without forcing the seller to author the full DAG up front.
 *  The seller refines via /agent/[id]/workflow after publish. */
function buildWorkflowSkeleton(form: FormState): string {
  const safeTitle = form.title.replace(/"/g, "'") || 'workflow';
  return JSON.stringify(
    {
      version: 'v1.1',
      name: `${safeTitle} (skeleton)`,
      para: { default_kind: 'project' },
      steps: [
        {
          id: 'capture-1', capability: 'web_search',
          depends_on: [], inputs: { query: '{{ buyer_input.request }}' },
          output_schema: { findings: 'string[]' },
          on_failure: 'halt', max_micro_usdc: 100_000, risk_tier: 'low',
        },
        {
          id: 'express-1', capability: 'summarize',
          depends_on: ['capture-1'], inputs: { findings: '{{ steps.capture-1.findings }}' },
          output_schema: { final_output: 'string' },
          on_failure: 'halt', max_micro_usdc: 200_000, risk_tier: 'medium',
        },
      ],
    },
    null,
    2,
  );
}

const inputCx = 'w-full rounded-lg border border-outline-variant/40 bg-surface-container-low px-3 py-2 text-sm text-on-surface focus:border-primary/60 focus:outline-none';

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
