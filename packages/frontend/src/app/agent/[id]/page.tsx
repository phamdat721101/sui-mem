'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import { AGENT_BACKEND_URL, api, priceFromPricing, triggerDownload, type Listing, type MemWalBrain, type WorkflowYaml } from '@/lib/api';
import { AgentRecentCalls } from '@/components/AgentRecentCalls';

/**
 * /agent/[id] — paid agent detail.
 *
 * Two flavours of `id`:
 *   - x402 slug (e.g. "wiz-trading")        → renders Listing detail
 *   - Sui object id (starts with "0x")      → renders MemWalBrain detail
 *
 * SOLID:
 *  - SRP: this file owns the detail layout. Inline subcomponents (CopyButton,
 *    Row) are page-local — extracting them would inflate file count without
 *    increasing reuse.
 *  - LSP: both flavours render through the same `<HeroBlock/>` shape, so the
 *    page is layout-stable across the two product types.
 */

export default function AgentDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';
  const isMemwal = id.startsWith('0x');

  const [listing, setListing] = useState<Listing | null>(null);
  const [brain, setBrain] = useState<MemWalBrain | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const promise = isMemwal
      ? api.memwalBrains().then((arr) => {
          if (!cancelled) setBrain(arr.find((b) => b.sui_object_id === id) ?? null);
        })
      : api.listing(id).then((l) => {
          if (!cancelled) setListing(l);
        });
    promise
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, isMemwal, retryNonce]);

  if (loading) return <div className="py-20 text-center text-on-surface-variant">Loading…</div>;
  if (error) {
    return (
      <div className="py-20 text-center">
        <p className="text-on-surface-variant">Couldn&apos;t load this agent ({error}).</p>
        <button
          type="button"
          onClick={() => setRetryNonce((n) => n + 1)}
          className="mt-3 inline-block rounded-full bg-primary px-4 py-1.5 text-sm font-medium text-on-primary hover:opacity-90"
        >
          Retry
        </button>
        <Link href="/marketplace" className="ml-3 inline-block text-sm text-on-surface-variant hover:text-primary">
          ← Back to marketplace
        </Link>
      </div>
    );
  }
  if (!listing && !brain) {
    return (
      <div className="py-20 text-center">
        <p className="text-on-surface-variant">Agent not found.</p>
        <Link href="/marketplace" className="mt-3 inline-block text-sm text-primary hover:underline">
          ← Back to marketplace
        </Link>
      </div>
    );
  }

  if (brain) return <MemWalDetail brain={brain} />;
  return <ListingDetail listing={listing!} />;
}

// ─── x402 paid-API listing detail ────────────────────────────────────────

function ListingDetail({ listing }: { listing: Listing }) {
  const price = priceFromPricing(listing.pricing);
  const url = `${AGENT_BACKEND_URL}/api/v1/${listing.slug}`;
  const curl = `curl '${url}?q=YOUR_QUESTION_HERE'`;
  const sampleResp = JSON.stringify(
    { answer: 'string', citations: [0, 1], settled: { method: 'sui-usdc' } },
    null,
    2,
  );
  const promptBody = listing.persona?.system_prompt?.trim() || autoGeneratePrompt(listing, url);
  const bundleSnippet = JSON.stringify(
    { tool: 'ask', agent_url: url, price_usdc: price?.amount ?? '0.01', args: { question: '{{user_input}}' } },
    null,
    2,
  );

  return (
    <div className="grid gap-6 md:grid-cols-3">
      <div className="min-w-0 space-y-6 md:col-span-2">
        <Header
          icon="smart_toy"
          title={listing.title}
          chips={[
            { label: 'LIVE', tone: 'secondary', icon: 'public' },
            { label: 'Sui', tone: 'secondary', icon: 'hub' },
          ]}
          subtitle={`Owner ${listing.id.slice(0, 8)}…${listing.id.slice(-4)}`}
        />

        <p className="text-on-surface-variant">{listing.description ?? listing.short_description}</p>

        {(listing.tags?.length ?? 0) > 0 && (
          <div className="flex flex-wrap gap-2">
            {listing.tags!.map((t) => (
              <span key={t} className="rounded-full border border-outline-variant/40 px-2 py-0.5 font-mono text-xs text-on-surface-variant">
                #{t}
              </span>
            ))}
          </div>
        )}

        <Card title="Make a call" tone="primary" cta={<CopyButton value={curl} label="Copy curl" />}>
          <pre className="overflow-x-auto rounded-lg bg-surface-container-low p-3 font-mono text-[12px]">
            <code>{curl}</code>
          </pre>
          <p className="text-xs text-on-surface-variant">
            Returns <code>402 Payment Required</code> on the first call — the n-payment SDK settles via Sui-USDC and retries with the receipt. After 200, response shape:
          </p>
          <pre className="overflow-x-auto rounded-lg bg-surface-container-low p-3 font-mono text-[11px] text-on-surface-variant">
            <code>{sampleResp}</code>
          </pre>
        </Card>

        <Card title="Agent prompt" cta={<CopyButton value={promptBody} label="Copy" />}>
          <p className="text-xs text-on-surface-variant">
            Paste this into Claude / ChatGPT to give the agent context to call your API.
          </p>
          <pre className="overflow-auto whitespace-pre-wrap rounded-lg bg-surface-container-low p-3 font-mono text-[12px]">
            {promptBody}
          </pre>
        </Card>

        <Card title="Bundle snippet" cta={<CopyButton value={bundleSnippet} label="Copy JSON" />}>
          <p className="text-xs text-on-surface-variant">
            Drop this step into your own bundle manifest to invoke this agent as part of an autonomous workflow.
          </p>
          <pre className="overflow-x-auto rounded-lg bg-surface-container-low p-3 font-mono text-[12px]">
            <code>{bundleSnippet}</code>
          </pre>
        </Card>
      </div>

      <aside className="min-w-0">
        <div className="sticky top-24 space-y-4 rounded-xl border border-primary/30 bg-surface p-6">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
              price per call
            </div>
            <div className="mt-1 font-headline text-2xl font-bold">
              ${price ? Number(price.amount).toFixed(4) : '0.0100'}
              <span className="ml-1 font-mono text-xs font-normal text-on-surface-variant">USDC</span>
            </div>
          </div>
          <div className="space-y-2 border-t border-outline-variant/20 pt-3 text-xs">
            <Row label="network" value="sui" mono />
            <Row label="rail" value={price?.rail ?? 'sui_usdc'} mono />
            <Row label="endpoint" value={`/api/v1/${listing.slug}`} mono />
            <Row label="published" value={new Date(listing.created_at).toLocaleDateString()} />
          </div>
          <Link
            href={`/agent/${listing.slug}/run`}
            className="flex w-full items-center justify-center gap-2 rounded-full bg-primary py-2 font-mono text-[11px] uppercase tracking-wider text-on-primary hover:opacity-90"
          >
            <span className="material-symbols-outlined text-[14px]">play_arrow</span>
            Run a task
          </Link>
          <RunWorkflowNowButton agentSlug={listing.slug} />
          <Link
            href={`/agent/${listing.slug}/integrate`}
            className="block w-full rounded-full border border-outline-variant/40 py-2 text-center font-mono text-[10px] uppercase tracking-wider hover:border-primary/40 hover:text-primary"
          >
            For AI integrators →
          </Link>
          <HireWorkflowButton agentSlug={listing.slug} />
          <CopyButton value={curl} label="Copy curl" full />
        </div>
        <div className="mt-4">
          <AgentRecentCalls slug={listing.slug} limit={6} />
        </div>
      </aside>
    </div>
  );
}

// ─── MemWal cognitive brain detail ───────────────────────────────────────

function MemWalDetail({ brain }: { brain: MemWalBrain }) {
  const queryCurl = `curl -X POST '${AGENT_BACKEND_URL}/v3/memory/brain/${brain.sui_object_id}/query' \\
  -H 'Content-Type: application/json' \\
  -H 'x-wallet-address: 0xyour_sui_address' \\
  -H 'x-payment-rail: sui_usdc' \\
  -d '{"query":"YOUR QUESTION","limit":5}'`;
  const mcp = JSON.stringify(
    { tool: 'memwal_marketplace_query', args: { brain_id: brain.sui_object_id, query: '{{user_input}}' } },
    null,
    2,
  );

  return (
    <div className="grid gap-6 md:grid-cols-3">
      <div className="min-w-0 space-y-6 md:col-span-2">
        <Header
          icon="psychology"
          title={brain.title}
          chips={[
            { label: `L${brain.cognitive_level}`, tone: 'matrix', icon: 'memory' },
            { label: 'Sui · Walrus · MemWal', tone: 'secondary', icon: 'hub' },
            ...(brain.attestation_required > 0
              ? [{ label: 'Seal-attested', tone: 'secondary' as const, icon: 'shield' }]
              : []),
          ]}
          subtitle={`Seller ${brain.seller_wallet.slice(0, 8)}…${brain.seller_wallet.slice(-4)}`}
        />

        {brain.description && <p className="text-on-surface-variant">{brain.description}</p>}

        <Card title="Paid recall" tone="primary" cta={<CopyButton value={queryCurl} label="Copy curl" />}>
          <pre className="overflow-x-auto rounded-lg bg-surface-container-low p-3 font-mono text-[11px]">
            <code>{queryCurl}</code>
          </pre>
          <p className="text-xs text-on-surface-variant">
            First call returns <code>402 Payment Required</code> with a Sui-USDC challenge. Pay via the
            programmable transaction <code className="font-mono">subscription_policy::subscribe</code>, then retry with the receipt.
            The response carries the recall hits + a privacy-receipt bundle (Seal IBE key derivation proof + Sui billing tx + Walrus blob ids).
          </p>
        </Card>

        <Card title="MCP invocation" cta={<CopyButton value={mcp} label="Copy JSON" />}>
          <p className="text-xs text-on-surface-variant">
            Use the MCP gateway from Claude / Cursor / AgentCore. The host pays via the standard JSON-RPC <code>-32402</code> envelope.
          </p>
          <pre className="overflow-x-auto rounded-lg bg-surface-container-low p-3 font-mono text-[12px]">
            <code>{mcp}</code>
          </pre>
        </Card>

        <Card title="Sovereignty proof" cta={
          <Link
            href={`${AGENT_BACKEND_URL}/v3/memory/brain/${brain.sui_object_id}/sovereignty-proof`}
            target="_blank"
            className="rounded-full border border-outline-variant/40 px-3 py-1 font-mono text-[10px] uppercase hover:border-primary/40"
          >
            Open ↗
          </Link>
        }>
          <p className="text-xs text-on-surface-variant">
            OpenX is not in the trust path. Use{' '}
            <code className="font-mono">@mysten-incubation/memwal restore()</code> with the namespace below to rebuild the index from Walrus alone.
          </p>
          <pre className="overflow-x-auto rounded-lg bg-surface-container-low p-3 font-mono text-[12px]">
            namespace: {brain.namespace}
            {'\n'}memwal_account_id: {brain.memwal_account_id}
            {'\n'}sui_object_id: {brain.sui_object_id}
          </pre>
        </Card>
      </div>

      <aside className="min-w-0">
        <div className="sticky top-24 space-y-4 rounded-xl border border-primary/30 bg-surface p-6">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
              price per query
            </div>
            <div className="mt-1 font-headline text-2xl font-bold">
              ${Number(brain.price_per_query_usdc).toFixed(4)}
              <span className="ml-1 font-mono text-xs font-normal text-on-surface-variant">USDC</span>
            </div>
          </div>
          <div className="space-y-2 border-t border-outline-variant/20 pt-3 text-xs">
            <Row label="cognitive level" value={`L${brain.cognitive_level}`} mono />
            <Row label="namespace" value={brain.namespace} mono />
            <Row label="kya" value={brain.kya_required ? 'required' : 'optional'} mono />
            <Row label="attestation" value={brain.attestation_required > 0 ? 'required' : 'optional'} mono />
          </div>
          <Link
            href={`https://suiscan.xyz/testnet/object/${brain.sui_object_id}`}
            target="_blank"
            className="flex w-full items-center justify-center gap-2 rounded-full bg-primary py-2 text-sm font-medium text-on-primary"
          >
            <span className="material-symbols-outlined text-[16px]">explore</span>
            View on Suiscan
          </Link>
          <RunWorkflowNowButton agentSlug={brain.sui_object_id} />
          <HireWorkflowButton agentSlug={brain.sui_object_id} />
        </div>
      </aside>
    </div>
  );
}

// ─── shared inline primitives ────────────────────────────────────────────

interface Chip { label: string; tone: 'primary' | 'secondary' | 'matrix'; icon?: string }

function Header({ icon, title, chips, subtitle }: { icon: string; title: string; chips: Chip[]; subtitle: string }) {
  const toneClass: Record<Chip['tone'], string> = {
    primary: 'border-primary/30 bg-primary/10 text-primary',
    secondary: 'border-secondary/30 bg-secondary/10 text-secondary',
    matrix: 'matrix-chip border border-secondary/20',
  };
  return (
    <div className="flex items-start gap-4 rounded-xl border border-outline-variant/30 bg-surface p-6">
      <div className="flex h-14 w-14 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <span className="material-symbols-outlined text-[28px]">{icon}</span>
      </div>
      <div className="flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-headline text-2xl font-bold">{title}</h1>
          {chips.map((c, i) => (
            <span key={i} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px] ${toneClass[c.tone]}`}>
              {c.icon && <span className="material-symbols-outlined text-[12px]">{c.icon}</span>}
              {c.label}
            </span>
          ))}
        </div>
        <p className="font-mono text-xs text-on-surface-variant">{subtitle}</p>
      </div>
    </div>
  );
}

function Card({ title, tone, cta, children }: { title: string; tone?: 'primary'; cta?: ReactNode; children: ReactNode }) {
  const border = tone === 'primary' ? 'border-primary/30' : 'border-outline-variant/30';
  return (
    <div className={`space-y-3 rounded-xl border ${border} bg-surface p-5`}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-headline text-base font-semibold">{title}</h2>
        {cta}
      </div>
      {children}
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-on-surface-variant">{label}</span>
      <span className={mono ? 'font-mono text-on-surface' : 'text-on-surface'}>{value}</span>
    </div>
  );
}

function CopyButton({ value, label, full }: { value: string; label: string; full?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {/* clipboard blocked */}
      }}
      className={`rounded-full border border-outline-variant/40 px-3 py-1 font-mono text-[10px] uppercase tracking-wider hover:border-primary/40 hover:text-primary ${
        full ? 'flex w-full items-center justify-center' : ''
      }`}
    >
      {copied ? '✓ copied' : label}
    </button>
  );
}

function autoGeneratePrompt(listing: Listing, url: string): string {
  const tagsLine =
    (listing.tags?.length ?? 0) > 0
      ? `When the user asks about ${listing.tags!.map((t) => `#${t}`).join(', ')}, call:\n`
      : `To use it, call:\n`;
  const price = priceFromPricing(listing.pricing);
  const priceLine = price ? `(price: ${price.amount} USDC per call, paid via Sui-USDC)` : `(free preview)`;
  return [
    `You have access to the "${listing.title}" agent on OpenX${listing.description ? ` — ${listing.description}` : ''}.`,
    '',
    tagsLine + `  GET ${url}?q=<the question>`,
    `  ${priceLine}`,
    '',
    'The response shape is:',
    '  { "answer": string, "citations": number[], "settled": { "method": "sui-usdc" } }',
    '',
    'Always cite the agent when its answer informs your reply.',
  ].join('\n');
}


// ─── Hire workflow (buyer-side, opens modal) ────────────────────────────

function HireWorkflowButton({ agentSlug }: { agentSlug: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="block w-full rounded-full border border-secondary/40 py-2 text-center font-mono text-[10px] uppercase tracking-wider text-secondary hover:bg-secondary/10"
      >
        Hire workflow →
      </button>
      {open && <HireWorkflowModal agentSlug={agentSlug} onClose={() => setOpen(false)} />}
    </>
  );
}

interface HireForm {
  area_slug: string;
  recurring: boolean;
  runs: number;
  cron_utc_minute: number;
  max_per_run_micro: number;
}

function HireWorkflowModal({ agentSlug, onClose }: { agentSlug: string; onClose: () => void }) {
  const account = useCurrentAccount();
  const [f, setF] = useState<HireForm>({
    area_slug: '',
    recurring: false,
    runs: 7,
    cron_utc_minute: 120,
    max_per_run_micro: 10_000_000,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // Load the seller's workflow so the buyer hires *seeing* what runs, not
  // a blank form. Endpoint is `wallet_required` only — buyer's wallet is
  // sufficient. Silent failure is intentional: a missing workflow shouldn't
  // block hiring (recurring jobs can still escrow against the seller).
  const [workflow, setWorkflow] = useState<WorkflowYaml | null>(null);
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  useEffect(() => {
    if (!account?.address) return;
    api.getWorkflow(account.address, agentSlug)
      .then((r) => setWorkflow(r.workflow))
      .catch((e: Error) => setWorkflowError(e.message));
  }, [account?.address, agentSlug]);

  const submit = async () => {
    if (!account?.address) {
      setError('connect wallet');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (!f.recurring) {
        // One-shot — link to the existing /run path which already wires the
        // x402 single-call flow. Workflow-shape one-shot is functionally
        // equivalent to Run-a-task in v1.1 spine.
        setDone('Use "Run a task" for one-shot calls — workflow is multi-step orchestration.');
        return;
      }
      const r = await fetch(`${AGENT_BACKEND_URL}/v3/loop/subscriptions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-wallet-address': account.address },
        body: JSON.stringify({
          agent_object_id: agentSlug,
          template_walrus_blob_id: 'pending-walrus-pin',
          area_slug: f.area_slug,
          cron_utc_minute: f.cron_utc_minute,
          runs: f.runs,
          max_per_run_micro: f.max_per_run_micro,
          budget_coin_object_id: 'pending-coin-select',
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error ?? `subscribe ${r.status}`);
      }
      const j = (await r.json()) as { subscription?: { runs_remaining: number } };
      setDone(
        `Subscription staged · ${j.subscription?.runs_remaining ?? f.runs} runs at ${formatHm(f.cron_utc_minute)} UTC. View in /activity.`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md space-y-4 rounded-xl border border-outline-variant/40 bg-surface p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="font-headline text-lg font-bold">Hire workflow</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-on-surface-variant hover:bg-on-surface/5"
            aria-label="close"
          >
            ✕
          </button>
        </div>

        <WorkflowPreview workflow={workflow} error={workflowError} />

        <div className="flex gap-2">
          <ToggleChip on={!f.recurring} onClick={() => setF({ ...f, recurring: false })} label="One-shot" />
          <ToggleChip on={f.recurring} onClick={() => setF({ ...f, recurring: true })} label="Daily recurring" />
        </div>

        <label className="block space-y-1">
          <span className="font-mono text-[10px] uppercase text-on-surface-variant">area_slug (optional)</span>
          <input
            value={f.area_slug}
            onChange={(e) => setF({ ...f, area_slug: e.target.value })}
            placeholder="vietnam-ev-content"
            className="w-full rounded-md bg-surface-container-low px-3 py-2 font-mono text-sm focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </label>

        {f.recurring && (
          <div className="grid grid-cols-3 gap-2 text-xs">
            <label className="space-y-1">
              <span className="font-mono uppercase text-on-surface-variant">runs</span>
              <input
                type="number" min={1} max={366}
                value={f.runs}
                onChange={(e) => setF({ ...f, runs: Math.max(1, Math.min(366, Number(e.target.value))) })}
                className="w-full rounded-md bg-surface-container-low px-2 py-2 font-mono"
              />
            </label>
            <label className="space-y-1">
              <span className="font-mono uppercase text-on-surface-variant">UTC time</span>
              <input
                type="time"
                value={formatHm(f.cron_utc_minute)}
                onChange={(e) => {
                  const [h, m] = e.target.value.split(':').map(Number);
                  setF({ ...f, cron_utc_minute: (h ?? 0) * 60 + (m ?? 0) });
                }}
                className="w-full rounded-md bg-surface-container-low px-2 py-2 font-mono"
              />
            </label>
            <label className="space-y-1">
              <span className="font-mono uppercase text-on-surface-variant">max µUSDC</span>
              <input
                type="number" min={0} step={100000}
                value={f.max_per_run_micro}
                onChange={(e) => setF({ ...f, max_per_run_micro: Number(e.target.value) })}
                className="w-full rounded-md bg-surface-container-low px-2 py-2 font-mono"
              />
            </label>
          </div>
        )}

        {f.recurring && (
          <div className="rounded-md border border-primary/20 bg-primary/5 p-2.5 text-[11px] font-mono text-on-surface-variant">
            escrow ≈ ${(f.runs * f.max_per_run_micro / 1_000_000).toFixed(2)} USDC · unused returned on cancel
          </div>
        )}

        {error && <div className="rounded-md border border-error/40 bg-error/10 p-2 text-xs text-error">{error}</div>}
        {done && <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-2 text-xs text-emerald-300">✓ {done}</div>}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-outline-variant/40 px-4 py-2 text-xs text-on-surface-variant"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || !account?.address}
            className="rounded-full bg-primary px-4 py-2 text-xs text-on-primary disabled:opacity-40"
          >
            {busy ? 'Submitting…' : f.recurring ? `Subscribe (${f.runs} runs)` : 'Hire one-shot'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ToggleChip({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 rounded-full border py-2 font-mono text-xs ${
        on
          ? 'border-primary/40 bg-primary/10 text-primary'
          : 'border-outline-variant/40 bg-surface-container-low text-on-surface-variant'
      }`}
    >
      {label}
    </button>
  );
}

/**
 * Read-only summary of the seller's saved workflow so the buyer hires with
 * eyes open. Renders step ids, capabilities and PARA phases — the same
 * shape the runtime executes, projected to a non-secret view (no inputs,
 * no per-step prompts, no risk tier).
 *
 * SOLID:
 *  - SRP: presentation only; the data fetch lives in HireWorkflowModal.
 *  - OCP: a new step type renders for free — `step.capability` + phase
 *    badge are generic.
 *  - Loading/empty/error are 3 cheap branches; no spinner library needed.
 */
function WorkflowPreview({
  workflow,
  error,
}: {
  workflow: WorkflowYaml | null;
  error: string | null;
}) {
  if (error) {
    return (
      <div className="rounded-md border border-outline-variant/30 bg-surface-container-low p-2.5 text-[11px] text-on-surface-variant">
        Couldn&apos;t load workflow preview ({error}). You can still subscribe.
      </div>
    );
  }
  if (!workflow) {
    return (
      <div className="rounded-md border border-outline-variant/20 bg-surface-container-low p-2.5 text-[11px] text-on-surface-variant">
        Loading workflow preview…
      </div>
    );
  }
  const steps = workflow.steps ?? [];
  if (!steps.length) {
    return (
      <div className="rounded-md border border-outline-variant/20 bg-surface-container-low p-2.5 text-[11px] text-on-surface-variant">
        Seller hasn&apos;t published a workflow yet.
      </div>
    );
  }
  return (
    <div className="rounded-md border border-primary/20 bg-primary/5 p-2.5">
      <div className="flex items-center justify-between text-[10px] font-mono uppercase">
        <span className="text-primary">Workflow · {workflow.name}</span>
        <span className="text-on-surface-variant">{steps.length} step{steps.length === 1 ? '' : 's'}</span>
      </div>
      <ol className="mt-1.5 space-y-1 text-[11px]">
        {steps.slice(0, 6).map((s, i) => (
          <li key={s.id} className="flex items-center gap-2">
            <span className="font-mono text-on-surface-variant">{String(i + 1).padStart(2, '0')}.</span>
            {s.phase && (
              <span className={`rounded px-1.5 py-0.5 font-mono text-[9px] uppercase ${PHASE_BADGE[s.phase] ?? 'bg-on-surface/10 text-on-surface-variant'}`}>
                {s.phase}
              </span>
            )}
            <span className="font-mono text-on-surface">{s.id}</span>
            <span className="ml-auto truncate font-mono text-[10px] text-on-surface-variant" title={s.capability}>
              {s.capability}
            </span>
          </li>
        ))}
        {steps.length > 6 && (
          <li className="pl-7 font-mono text-[10px] text-on-surface-variant">
            … +{steps.length - 6} more
          </li>
        )}
      </ol>
    </div>
  );
}

const PHASE_BADGE: Record<NonNullable<WorkflowYaml['steps'][number]['phase']>, string> = {
  capture:  'bg-blue-500/15 text-blue-300',
  organize: 'bg-amber-500/15 text-amber-300',
  distill:  'bg-purple-500/15 text-purple-300',
  express:  'bg-emerald-500/15 text-emerald-300',
};

function formatHm(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}


// ─── PRD-S — Run workflow now (buyer instant run) ───────────────────────

function RunWorkflowNowButton({ agentSlug }: { agentSlug: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="block w-full rounded-full border border-primary/40 bg-primary/5 py-2 text-center font-mono text-[10px] uppercase tracking-wider text-primary hover:bg-primary/10"
      >
        ✨ Run workflow now
      </button>
      {open && <RunWorkflowNowModal agentSlug={agentSlug} onClose={() => setOpen(false)} />}
    </>
  );
}

interface RunResult {
  steps_completed: number;
  steps_total: number;
  per_step: Array<{
    id: string; phase: string; status: string;
    spent_micro: number; output: Record<string, unknown>;
  }>;
  final_output: string;
  ms: number;
  tx_digest?: string | null;
  paid_micro_usdc?: string | null;
}

function RunWorkflowNowModal({ agentSlug, onClose }: { agentSlug: string; onClose: () => void }) {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const [request, setRequest] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);

  const run = async () => {
    if (!account?.address) {
      setError('connect wallet');
      return;
    }
    if (request.trim().length < 1) {
      setError('describe your request');
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    setStatus('Requesting price…');
    try {
      // 1. First call — server returns 402 with price challenge if payment needed.
      const url = `${AGENT_BACKEND_URL}/v3/loop/agents/${encodeURIComponent(agentSlug)}/run-workflow`;
      const headers = { 'Content-Type': 'application/json', 'x-wallet-address': account.address };
      const challenge = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ request: request.trim() }),
      });

      // No payment required path (env unset on backend) — render directly.
      if (challenge.ok) {
        setResult((await challenge.json()) as RunResult);
        return;
      }

      const challengeJson = (await challenge.json()) as {
        error?: string;
        price_micro_usdc?: string;
        seller?: string;
        platform?: string;
        platform_bps?: number;
        usdc_coin_type?: string;
      };

      if (challenge.status === 422 && challengeJson.error === 'no_workflow_saved') {
        setError('This agent has no workflow saved yet. Try "Run a task" instead, or ask the seller to publish a workflow.');
        return;
      }
      if (challenge.status !== 402 || !challengeJson.price_micro_usdc || !challengeJson.seller) {
        throw new Error(challengeJson.error ?? `unexpected ${challenge.status}`);
      }

      // 2. Build the USDC payment PTB (95% seller / 5% platform).
      setStatus('Approve payment in your wallet…');
      const usdcCoinType = challengeJson.usdc_coin_type!;
      const coins = await client.getCoins({ owner: account.address, coinType: usdcCoinType, limit: 1 });
      if (!coins.data.length) {
        throw new Error(`No USDC found in your wallet for coin type ${usdcCoinType.slice(0, 24)}…`);
      }
      const priceMicro = BigInt(challengeJson.price_micro_usdc);
      const platformBps = BigInt(challengeJson.platform_bps ?? 500);
      const platformCut = (priceMicro * platformBps) / 10_000n;
      const sellerCut = priceMicro - platformCut;

      const tx = new Transaction();
      // Split the source USDC coin once with both cuts. The source coin is a
      // PTB parameter (owned by sender) so its remainder auto-returns to the
      // buyer — nothing extra to transfer. Splitting twice from a synthetic
      // intermediate coin produces an UnusedValueWithoutDrop error because
      // Coin<T> lacks the `drop` ability.
      const [sellerCoin, platformCoin] = tx.splitCoins(
        tx.object(coins.data[0].coinObjectId),
        [tx.pure.u64(sellerCut), tx.pure.u64(platformCut)],
      );
      tx.transferObjects([sellerCoin], tx.pure.address(challengeJson.seller!));
      if (challengeJson.platform) {
        tx.transferObjects([platformCoin], tx.pure.address(challengeJson.platform));
      } else {
        // No platform configured → return platform cut to buyer.
        tx.transferObjects([platformCoin], tx.pure.address(account.address));
      }

      const signed = await signAndExecute({
        transaction: tx as unknown as Parameters<typeof signAndExecute>[0]['transaction'],
      });

      // Wait for the tx to be indexed on the fullnode before posting the digest
      // — otherwise the server's RPC may race and return "tx not found".
      try {
        await client.waitForTransaction({ digest: signed.digest, timeout: 20_000 });
      } catch {
        // Non-fatal — server has its own retry loop.
      }

      // 3. Resubmit with payment_tx_digest.
      setStatus('Running workflow…');
      const r2 = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ request: request.trim(), payment_tx_digest: signed.digest }),
      });
      if (!r2.ok) {
        const j = await r2.json().catch(() => ({}));
        throw new Error(j.error ?? `run ${r2.status}`);
      }
      setResult((await r2.json()) as RunResult);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setStatus(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl space-y-4 rounded-xl border border-outline-variant/40 bg-surface p-5 max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-headline text-lg font-bold">✨ Run workflow now</h2>
            <p className="text-xs text-on-surface-variant">
              Multi-step workflow runs in seconds · pay USDC per run
              <span className="ml-1 rounded bg-emerald-500/15 px-1 font-mono text-[10px] text-emerald-300">Sui-paid</span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-on-surface-variant hover:bg-on-surface/5"
            aria-label="close"
          >
            ✕
          </button>
        </div>

        <label className="block space-y-1">
          <span className="font-mono text-[10px] uppercase text-on-surface-variant">Your request</span>
          <textarea
            value={request}
            onChange={(e) => setRequest(e.target.value.slice(0, 2000))}
            rows={3}
            placeholder="Today's EV news in Vietnam — write a Twitter thread"
            className="w-full rounded-md bg-surface-container-low px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            disabled={busy}
          />
        </label>

        {!result && (
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-full border border-outline-variant/40 px-4 py-2 text-xs text-on-surface-variant"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={run}
              disabled={busy || !account?.address}
              className="rounded-full bg-primary px-4 py-2 text-xs text-on-primary disabled:opacity-40"
            >
              {busy ? (status ?? 'Running…') : '▶ Pay & Run'}
            </button>
          </div>
        )}

        {busy && status && (
          <div className="rounded-md border border-primary/30 bg-primary/5 p-2 text-xs text-on-surface-variant">
            <span className="material-symbols-outlined animate-spin text-[14px] align-middle">progress_activity</span>
            <span className="ml-1.5 align-middle">{status}</span>
          </div>
        )}

        {error && <div className="rounded-md border border-error/40 bg-error/10 p-2 text-xs text-error">{error}</div>}

        {result && (
          <>
            <div className="space-y-1.5 rounded-lg border border-outline-variant/20 bg-surface-container-low p-3 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-mono uppercase text-on-surface-variant">Run · {result.steps_completed}/{result.steps_total} steps · {result.ms}ms</span>
                {result.paid_micro_usdc && (
                  <span className="font-mono text-[10px] text-emerald-300">
                    paid ${(Number(result.paid_micro_usdc) / 1_000_000).toFixed(4)} USDC
                  </span>
                )}
              </div>
              {result.tx_digest && (
                <div className="font-mono text-[10px] text-on-surface-variant break-all">
                  tx · <a href={`https://suiscan.xyz/testnet/tx/${result.tx_digest}`} target="_blank" rel="noreferrer" className="text-primary hover:underline">{result.tx_digest.slice(0, 16)}…{result.tx_digest.slice(-8)}</a>
                </div>
              )}
              {result.per_step.map((s) => (
                <RunStepRow key={s.id} step={s} />
              ))}
            </div>

            {result.final_output && (
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <h3 className="font-mono text-[10px] uppercase text-on-surface-variant">Result</h3>
                  <button
                    type="button"
                    onClick={() => {
                      // Same trigger pattern reused by the vault download —
                      // single helper, no per-page reimplementation.
                      const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
                      triggerDownload(
                        new Blob([result.final_output], { type: 'text/markdown' }),
                        `${agentSlug}-${ts}.md`,
                      );
                    }}
                    className="rounded-full border border-primary/40 bg-primary/5 px-2.5 py-0.5 font-mono text-[10px] uppercase text-primary hover:bg-primary/10"
                    title="Download as Markdown"
                  >
                    ↓ .md
                  </button>
                </div>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-container-low p-3 text-[12px] font-mono">
                  {result.final_output}
                </pre>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => { setResult(null); setRequest(''); }}
                className="rounded-full border border-outline-variant/40 px-4 py-2 text-xs text-on-surface-variant"
              >
                New request
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded-full bg-primary px-4 py-2 text-xs text-on-primary"
              >
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function RunStepRow({ step }: { step: RunResult['per_step'][number] }) {
  const phaseColor: Record<string, string> = {
    capture:  'bg-blue-500/15 text-blue-300',
    organize: 'bg-amber-500/15 text-amber-300',
    distill:  'bg-purple-500/15 text-purple-300',
    express:  'bg-emerald-500/15 text-emerald-300',
  };
  const tag = phaseColor[step.phase] ?? 'bg-on-surface/10 text-on-surface-variant';
  const status = step.status === 'ok' ? '✓' : step.status === 'failed' ? '✗' : '·';
  return (
    <div className="flex items-center gap-2 font-mono text-[11px]">
      <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${tag}`}>{step.phase}</span>
      <span className="text-on-surface">{status} {step.id}</span>
      <span className="ml-auto text-on-surface-variant">${(step.spent_micro / 1_000_000).toFixed(4)}</span>
    </div>
  );
}
