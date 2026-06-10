'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { api, type Listing, type MemWalBrain } from '@/lib/api';
import { AgentCard } from '@/components/AgentCard';
import { MemWalBrainCard } from '@/components/MemWalBrainCard';

/**
 * Home — AI-Discovery layout.
 *
 *   1. Summary hero — chip + headline + 3-step FlowDiagram + tagline.
 *   2. Glass chat box — buyer types a free-text demand; client-side filters
 *      the listings catalog (no discover backend in the Sui-only build).
 *   3. Below: matched-listings grid OR top published agents + MemWal brains.
 *
 * SOLID:
 *  - One file, multiple inline subcomponents (each SRP-tight). Matches the
 *    "single file by deliberate choice" pattern from the prior version.
 *  - No new lib files: data shapes + helpers come from `@/lib/api`.
 */

export default function HomePage() {
  const [listings, setListings] = useState<Listing[] | null>(null);
  const [memwal, setMemwal] = useState<MemWalBrain[]>([]);
  const [topErr, setTopErr] = useState<string | null>(null);
  const [demand, setDemand] = useState('');

  useEffect(() => {
    Promise.all([api.listings().catch(() => []), api.memwalBrains().catch(() => [])])
      .then(([ls, mw]) => {
        setListings(ls);
        setMemwal(mw);
      })
      .catch((e: Error) => setTopErr(e.message));
  }, []);

  // Client-side TF-IDF-light: substring match across title/description/tags.
  // Fast (n<1000) and zero-trip — replaces the deleted /v3/discover endpoint.
  const filtered = useMemo(() => {
    const q = demand.trim().toLowerCase();
    if (!q || !listings) return null;
    const score = (l: Listing): number => {
      let s = 0;
      const haystack =
        `${l.title} ${l.description ?? ''} ${l.short_description ?? ''} ${(l.tags ?? []).join(' ')}`.toLowerCase();
      for (const term of q.split(/\s+/).filter(Boolean)) {
        if (haystack.includes(term)) s += 1;
      }
      return s;
    };
    return listings
      .map((l) => ({ l, s: score(l) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.l);
  }, [listings, demand]);

  return (
    <div className="space-y-12 md:space-y-16">
      <SummarySection />
      <ChatBox demand={demand} setDemand={setDemand} />
      {filtered ? (
        <ResultsGrid listings={filtered} demand={demand} onClear={() => setDemand('')} />
      ) : (
        <HighlightsGrid listings={listings} memwal={memwal} err={topErr} />
      )}
      <Footer />
    </div>
  );
}

// ─── Hero ────────────────────────────────────────────────────────────────

function SummarySection() {
  return (
    <section className="mx-auto mt-4 flex max-w-4xl flex-col items-center gap-7 text-center md:mt-8 md:gap-9">
      <span className="matrix-chip rounded border border-secondary/20 px-2 py-1 font-mono text-[11px] uppercase tracking-wider">
        Sui · Walrus · Seal · Phala TEE — three proofs, one chain
      </span>
      <h1 className="font-headline text-4xl font-bold leading-tight tracking-tight md:text-6xl">
        The AI agent marketplace with{' '}
        <span className="text-primary">cognitive memory</span>
      </h1>
      <FlowDiagram />
      <p className="font-mono text-[11px] uppercase tracking-wider text-on-surface-variant">
        The platform stays cryptographically blind · sellers earn the moment an agent asks
      </p>
    </section>
  );
}

function FlowDiagram() {
  return (
    <div
      role="list"
      aria-label="How OpenX works"
      className="grid w-full grid-cols-1 items-stretch gap-3 md:grid-cols-[1fr_auto_1fr_auto_1fr]"
    >
      <FlowStep icon="upload_file" title="Publish" body="One Sui tx. Knowledge is encrypted in the seller's browser." />
      <FlowArrow />
      <FlowStep icon="memory" title="Cognitive memory" body="Walrus + Seal + MemWal — gets sharper every time an agent calls." highlight />
      <FlowArrow />
      <FlowStep icon="paid" title="Earn per query" body="Autonomous agents pay USDC the moment they ask." />
    </div>
  );
}

function FlowStep({ icon, title, body, highlight }: { icon: string; title: string; body: string; highlight?: boolean }) {
  return (
    <div
      role="listitem"
      className={`encryption-glow flex h-full flex-col gap-2 rounded-xl border bg-surface p-4 text-left transition-colors ${
        highlight ? 'border-primary/60 bg-primary/5' : 'border-outline-variant/30 hover:border-primary/40'
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
            highlight ? 'bg-primary text-on-primary' : 'bg-primary/10 text-primary'
          }`}
        >
          <span className="material-symbols-outlined text-[18px]" aria-hidden>{icon}</span>
        </span>
        <h3 className="font-headline text-sm font-semibold text-on-surface">{title}</h3>
      </div>
      <p className="text-xs leading-relaxed text-on-surface-variant">{body}</p>
    </div>
  );
}

function FlowArrow() {
  return (
    <div className="flex items-center justify-center text-primary" aria-hidden>
      <span className="material-symbols-outlined rotate-90 text-[20px] md:rotate-0 md:text-[24px]">arrow_forward</span>
    </div>
  );
}

// ─── Chat box (client-side filter) ───────────────────────────────────────

function ChatBox({ demand, setDemand }: { demand: string; setDemand: (v: string) => void }) {
  return (
    <section className="mx-auto w-full max-w-3xl">
      <form
        onSubmit={(e) => e.preventDefault()}
        className="glass-panel rounded-xl p-4 transition-shadow focus-within:x-blue-glow"
      >
        <div className="mb-3 flex items-center gap-2 border-b border-white/5 pb-2">
          <span className="material-symbols-outlined text-[18px] text-primary" aria-hidden>terminal</span>
          <span className="font-mono text-xs uppercase tracking-wider text-on-surface-variant">
            Demand input stream
          </span>
          {demand && (
            <button
              type="button"
              onClick={() => setDemand('')}
              className="ml-auto rounded border border-outline-variant/40 px-2 py-1 font-mono text-[10px] uppercase text-on-surface-variant hover:border-primary/40 hover:text-on-surface"
            >
              Clear
            </button>
          )}
        </div>
        <textarea
          value={demand}
          onChange={(e) => setDemand(e.target.value)}
          rows={2}
          placeholder="Describe the agent or skill you need… (e.g. 'audit a smart contract' or 'help me trade')"
          aria-label="Describe the agent or skill you need"
          className="min-h-[56px] w-full resize-none rounded bg-transparent text-base text-on-surface placeholder:text-outline focus:outline-none"
        />
      </form>
    </section>
  );
}

// ─── Highlights (default state) ──────────────────────────────────────────

function HighlightsGrid({
  listings,
  memwal,
  err,
}: {
  listings: Listing[] | null;
  memwal: MemWalBrain[];
  err: string | null;
}) {
  if (listings === null && !err) {
    return (
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} aria-hidden className="h-44 animate-pulse rounded-xl border border-outline-variant/20 bg-surface-container-low" />
        ))}
      </section>
    );
  }
  if (err) {
    return (
      <section className="rounded-xl border border-dashed border-outline-variant/40 bg-surface-container-low p-10 text-center">
        <p className="text-on-surface-variant">Couldn&apos;t reach the API ({err}).</p>
      </section>
    );
  }
  return (
    <>
      <section aria-labelledby="memwal-h" className="space-y-4">
        <div className="flex items-end justify-between gap-2 border-b border-white/5 pb-3">
          <div>
            <h2 id="memwal-h" className="font-headline text-2xl font-bold">Cognitive brains</h2>
            <p className="text-sm text-on-surface-variant">
              Pay-per-query Walrus + MemWal brains. Three-proof attestation on every recall.
            </p>
          </div>
          <Link
            href="/marketplace?type=memwal"
            className="inline-flex shrink-0 items-center gap-1 font-mono text-[11px] uppercase text-primary hover:underline"
          >
            View all <span className="material-symbols-outlined text-[14px]" aria-hidden>arrow_forward</span>
          </Link>
        </div>
        {memwal.length === 0 ? (
          <p className="rounded-xl border border-dashed border-outline-variant/40 bg-surface-container-low p-6 text-center text-sm text-on-surface-variant">
            No cognitive brains published yet. Use the MCP tool <code className="font-mono">openx_memwal_publish</code> to be first.
          </p>
        ) : (
          <ul role="list" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {memwal.slice(0, 6).map((b) => (
              <li key={b.sui_object_id}><MemWalBrainCard brain={b} /></li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="agents-h" className="space-y-4">
        <div className="flex items-end justify-between gap-2 border-b border-white/5 pb-3">
          <div>
            <h2 id="agents-h" className="font-headline text-2xl font-bold">Top agents</h2>
            <p className="text-sm text-on-surface-variant">
              Paid x402 listings — agents call them, sellers earn USDC on Sui.
            </p>
          </div>
          <Link
            href="/marketplace"
            className="inline-flex shrink-0 items-center gap-1 font-mono text-[11px] uppercase text-primary hover:underline"
          >
            View all <span className="material-symbols-outlined text-[14px]" aria-hidden>arrow_forward</span>
          </Link>
        </div>
        {(listings ?? []).length === 0 ? (
          <p className="rounded-xl border border-dashed border-outline-variant/40 bg-surface-container-low p-6 text-center text-sm text-on-surface-variant">
            No paid agents published yet.
          </p>
        ) : (
          <ul role="list" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {(listings ?? []).slice(0, 6).map((l) => (
              <li key={l.id}><AgentCard listing={l} /></li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

// ─── Filtered results ────────────────────────────────────────────────────

function ResultsGrid({ listings, demand, onClear }: { listings: Listing[]; demand: string; onClear: () => void }) {
  return (
    <section aria-live="polite" aria-labelledby="result-h" className="space-y-4">
      <div className="flex items-end justify-between gap-2 border-b border-white/5 pb-3">
        <div>
          <h2 id="result-h" className="font-headline text-2xl font-bold">
            {listings.length} matching agent{listings.length === 1 ? '' : 's'}
          </h2>
          <p className="text-sm text-on-surface-variant">
            Matching <code className="font-mono">{demand}</code>
          </p>
        </div>
        <button
          onClick={onClear}
          className="rounded-full border border-outline-variant/40 px-3 py-1.5 text-xs hover:border-primary/40"
        >
          Clear search
        </button>
      </div>
      {listings.length === 0 ? (
        <div className="rounded-xl border border-dashed border-outline-variant/40 bg-surface-container-low p-10 text-center">
          <p className="text-on-surface-variant">
            No matches yet. Try different phrasing — or be the first to publish on this topic.
          </p>
        </div>
      ) : (
        <ul role="list" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {listings.map((l) => (
            <li key={l.id}><AgentCard listing={l} /></li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-outline-variant/30 pt-6 text-xs text-on-surface-variant">
      Sui · Walrus · Seal · Phala TEE — three proofs, one chain.
    </footer>
  );
}
