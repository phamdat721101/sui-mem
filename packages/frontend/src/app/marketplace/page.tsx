'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, type Listing, type MemWalBrain } from '@/lib/api';
import { AgentCard } from '@/components/AgentCard';
import { MemWalBrainCard } from '@/components/MemWalBrainCard';
import { ConciergeChat } from '@/components/loop/ConciergeChat';

type Tab = 'all' | 'agents' | 'memwal';

const TABS: { key: Tab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'agents', label: 'Agents' },
  { key: 'memwal', label: 'Cognitive brains' },
];

export default function MarketplacePage() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('all');
  const [agents, setAgents] = useState<Listing[]>([]);
  const [brains, setBrains] = useState<MemWalBrain[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [activeTag, setActiveTag] = useState<string | null>(null);

  // Read ?type= once on mount.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const t = new URLSearchParams(window.location.search).get('type');
    if (t === 'agents' || t === 'memwal') setTab(t);
  }, []);

  useEffect(() => {
    setLoading(true);
    Promise.all([api.listings().catch(() => []), api.memwalBrains().catch(() => [])])
      .then(([a, b]) => {
        setAgents(a);
        setBrains(b);
      })
      .finally(() => setLoading(false));
  }, []);

  const tags = useMemo(() => {
    const seen = new Map<string, number>();
    for (const a of agents) for (const t of a.tags ?? []) seen.set(t, (seen.get(t) ?? 0) + 1);
    return Array.from(seen.entries()).sort((x, y) => y[1] - x[1]).slice(0, 10).map(([t]) => t);
  }, [agents]);

  const filteredAgents = useMemo(() => {
    const q = search.toLowerCase().trim();
    return agents.filter((a) => {
      if (activeTag && !(a.tags ?? []).includes(activeTag)) return false;
      if (!q) return true;
      const hay = `${a.title} ${a.description ?? ''} ${a.short_description ?? ''} ${(a.tags ?? []).join(' ')}`.toLowerCase();
      return hay.includes(q);
    });
  }, [agents, search, activeTag]);

  const filteredBrains = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return brains;
    return brains.filter((b) =>
      `${b.title} ${b.description ?? ''} ${b.namespace}`.toLowerCase().includes(q),
    );
  }, [brains, search]);

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <span className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-3 py-1 font-mono text-[10px] text-primary">
          MARKETPLACE · HIRE AGENTS
        </span>
        <h1 className="font-headline text-3xl font-bold leading-tight md:text-4xl">
          Hire <em className="text-primary">loops</em>, not prompts.
        </h1>
        <p className="max-w-2xl text-on-surface-variant">
          Tell us what you need done. We&apos;ll route you to the right Sui-native agent —
          a multi-step loop for ongoing work, or a one-shot agent for instant tasks.
          USDC settles in one signature.
        </p>
      </header>

      <ConciergeChat />

      <div className="space-y-2 border-t border-outline-variant/20 pt-6">
        <h2 className="font-headline text-xl font-bold">Browse the catalog</h2>
        <p className="text-sm text-on-surface-variant">
          Or skip the chat and search Sui-native AI agents directly. Every answer is paid in USDC; brains stay sealed by Seal IBE.
        </p>
      </div>

      <SellOnOpenXBanner />

      <div className="relative">
        <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[18px] text-on-surface-variant">
          search
        </span>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search agents, capabilities, tags…"
          className="w-full rounded-full border border-outline-variant/40 bg-surface py-3 pl-10 pr-4 text-on-surface placeholder:text-on-surface-variant focus:border-primary/60 focus:outline-none"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => {
              setTab(t.key);
              const params = new URLSearchParams(window.location.search);
              if (t.key === 'all') params.delete('type');
              else params.set('type', t.key);
              router.replace(`/marketplace${params.toString() ? '?' + params.toString() : ''}`);
            }}
            className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
              tab === t.key
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-outline-variant/40 text-on-surface-variant hover:border-primary/40'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab !== 'memwal' && tags.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setActiveTag(null)}
            className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${
              activeTag === null
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-outline-variant/40 text-on-surface-variant hover:border-primary/40'
            }`}
          >
            All tags
          </button>
          {tags.map((t) => (
            <button
              key={t}
              onClick={() => setActiveTag(t === activeTag ? null : t)}
              className={`rounded-full border px-3 py-1.5 font-mono text-xs transition-colors ${
                activeTag === t
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-outline-variant/40 text-on-surface-variant hover:border-primary/40'
              }`}
            >
              #{t}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="py-20 text-center text-on-surface-variant">Loading marketplace…</div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {(tab === 'all' || tab === 'agents') &&
            filteredAgents.map((a) => <AgentCard key={a.id} listing={a} />)}
          {(tab === 'all' || tab === 'memwal') &&
            filteredBrains.map((b) => <MemWalBrainCard key={b.sui_object_id} brain={b} />)}
        </div>
      )}

      {!loading &&
        ((tab === 'agents' && filteredAgents.length === 0) ||
          (tab === 'memwal' && filteredBrains.length === 0) ||
          (tab === 'all' && filteredAgents.length === 0 && filteredBrains.length === 0)) && (
          <p className="py-8 text-center text-sm text-on-surface-variant">
            No matches. Adjust filters or search.
          </p>
        )}
    </div>
  );
}

function SellOnOpenXBanner() {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-secondary/30 bg-secondary/5 px-4 py-3">
      <div className="flex items-start gap-3">
        <span className="material-symbols-outlined mt-0.5 text-secondary" aria-hidden>sell</span>
        <div>
          <div className="text-sm font-medium text-on-surface">Have knowledge worth selling?</div>
          <div className="text-xs text-on-surface-variant">
            Publish a Sui MemWal brain and earn USDC per query. Knowledge stays encrypted in your browser.
          </div>
        </div>
      </div>
      <a
        href="https://docs.openx.so/publish"
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 rounded-full bg-secondary/20 px-3 py-1.5 text-xs font-medium text-secondary transition-colors hover:bg-secondary/30"
      >
        Publishing guide
        <span className="material-symbols-outlined text-[14px]" aria-hidden>arrow_forward</span>
      </a>
    </div>
  );
}
