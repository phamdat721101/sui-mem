'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit';
import { api, type SellerDashboard } from '@/lib/api';

/**
 * /studio — seller dashboard.
 *
 *   • Earnings strip (last 7d, 30d, all-time).
 *   • My listings (links to /agent/<slug>).
 *   • CTAs: Publish a new agent · Train a MemWal brain.
 *
 * SOLID:
 *  - SRP: data fetch + render. No business logic — `lib/api` owns the wire.
 *  - DIP: depends on `SellerDashboard` shape, never on URL strings.
 */

export default function StudioPage() {
  const account = useCurrentAccount();
  if (!account) return <ConnectGate />;
  return <Studio wallet={account.address} />;
}

function Studio({ wallet }: { wallet: string }) {
  const [data, setData] = useState<SellerDashboard | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.sellerDashboard(wallet)
      .then(setData)
      .catch((e: Error) => setErr(e.message));
  }, [wallet]);

  if (err) {
    return (
      <div className="rounded-xl border border-error/30 bg-error/10 p-6 text-sm text-error">
        Couldn&apos;t load your dashboard: {err}
      </div>
    );
  }
  if (!data) {
    return <div className="py-20 text-center text-on-surface-variant">Loading studio…</div>;
  }

  const totals = data.earnings ?? { last_7d: '0', last_30d: '0', all_time: '0', calls_7d: 0 };
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-headline text-3xl font-bold">Studio</h1>
          <p className="text-on-surface-variant">
            Manage your published agents and your MemWal brain.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/studio/publish"
            className="inline-flex items-center gap-1 rounded-full bg-primary px-4 py-2 text-sm font-medium text-on-primary hover:opacity-90"
          >
            <span className="material-symbols-outlined text-[16px]">add</span> Publish agent
          </Link>
        </div>
      </div>

      <section className="grid gap-3 sm:grid-cols-3">
        <Stat label="Earned · 7d" value={`$${Number(totals.last_7d).toFixed(2)}`} sub={`${totals.calls_7d} calls`} />
        <Stat label="Earned · 30d" value={`$${Number(totals.last_30d).toFixed(2)}`} />
        <Stat label="Earned · all-time" value={`$${Number(totals.all_time).toFixed(2)}`} />
      </section>

      <section className="space-y-3">
        <h2 className="font-headline text-xl font-bold">My agents</h2>
        {data.agents.length === 0 ? (
          <div className="rounded-xl border border-dashed border-outline-variant/40 bg-surface-container-low p-10 text-center">
            <p className="text-on-surface-variant">No agents yet.</p>
            <Link href="/studio/publish" className="mt-3 inline-block text-sm text-primary hover:underline">
              Publish your first agent →
            </Link>
          </div>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {data.agents.map((a) => (
              <li
                key={a.id}
                className="encryption-glow flex flex-col gap-2 rounded-xl border border-outline-variant/30 bg-surface p-4"
              >
                <div className="flex items-center justify-between gap-2">
                  <Link href={`/agent/${a.slug}`} className="font-headline text-base font-semibold hover:text-primary">
                    {a.slug}
                  </Link>
                  <span className="rounded-full border border-outline-variant/40 px-2 py-0.5 font-mono text-[10px] uppercase text-on-surface-variant">
                    {a.domain}
                  </span>
                </div>
                <div className="flex items-end justify-between gap-2 border-t border-outline-variant/20 pt-2 text-xs">
                  <span className="text-on-surface-variant">
                    {a.calls_total} calls · earned ${Number(a.earned_total).toFixed(4)}
                  </span>
                  <div className="flex items-center gap-3">
                    <Link href={`/studio/agent/${a.slug}/config`} className="font-mono text-[11px] text-secondary hover:underline">
                      config ↗
                    </Link>
                    <Link href={`/studio/agent/${a.slug}/train`} className="font-mono text-[11px] text-secondary hover:underline">
                      train ↗
                    </Link>
                    <Link href={`/agent/${a.slug}`} className="font-mono text-[11px] text-primary">
                      view ↗
                    </Link>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-outline-variant/30 bg-surface p-5">
      <div className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">{label}</div>
      <div className="mt-1 font-headline text-2xl font-bold">{value}</div>
      {sub && <div className="mt-0.5 font-mono text-[11px] text-on-surface-variant">{sub}</div>}
    </div>
  );
}

function ConnectGate() {
  return (
    <div className="mx-auto max-w-xl rounded-xl border border-dashed border-outline-variant/40 bg-surface-container-low p-12 text-center">
      <span className="material-symbols-outlined text-[36px] text-primary">lock_open</span>
      <h1 className="mt-2 font-headline text-2xl font-bold">Connect to enter the Studio</h1>
      <p className="mt-2 text-sm text-on-surface-variant">
        Your Sui wallet is your identity on OpenX. Connect to publish, train, and earn.
      </p>
      <p className="mt-3 font-mono text-[11px] uppercase tracking-widest text-outline">
        Use the Connect Sui button in the top bar.
      </p>
    </div>
  );
}
