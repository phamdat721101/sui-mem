'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { AGENT_BACKEND_URL, api, priceFromPricing, type Listing, type MemWalBrain } from '@/lib/api';
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
          <Link
            href={`/agent/${listing.slug}/integrate`}
            className="block w-full rounded-full border border-outline-variant/40 py-2 text-center font-mono text-[10px] uppercase tracking-wider hover:border-primary/40 hover:text-primary"
          >
            For AI integrators →
          </Link>
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
