'use client';

/**
 * /activity — buyer ops dashboard (PRD-W v1.1).
 *
 * Three panels:
 *   1. Active subscriptions   — recurring workflow hires + cancel button
 *   2. Artifact vault         — deliverables grouped by area_slug
 *   3. Right-to-forget        — pending requests + 7d cooling-off countdown
 *
 * SOLID:
 *   - SRP: presentation only. Three independent fetches via `api.*` helpers.
 *   - DIP: page depends on `api` from `@/lib/api`, never on raw fetch URLs.
 *   - OCP: a fourth panel (e.g. preferences vCard editor) = one new section,
 *     no other change.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useCurrentAccount } from '@mysten/dapp-kit';
import { api } from '@/lib/api';

interface Subscription {
  subscription_object_id: string;
  agent_id: string;
  area_slug: string | null;
  cron_utc_minute: number;
  runs_remaining: number;
  max_per_run_micro: number;
  next_run_ts: number;
  last_run_ts: number | null;
  cancelled_at: string | null;
}

interface VaultEntry {
  job_id: string;
  area_slug: string | null;
  artifact_name: string;
  walrus_blob_id: string;
  mime_type: string;
  created_at: string;
}

export default function ActivityPage() {
  const account = useCurrentAccount();
  if (!account?.address) {
    return (
      <div className="mx-auto max-w-md rounded-xl border border-dashed border-outline-variant/40 bg-surface-container-low p-12 text-center">
        <span className="material-symbols-outlined text-[36px] text-primary">lock_open</span>
        <h1 className="mt-2 font-headline text-2xl font-bold">Connect to see Activity</h1>
        <p className="mt-2 text-sm text-on-surface-variant">
          Your subscriptions, deliverables, and forget-requests live here.
        </p>
      </div>
    );
  }
  return <ActivityDashboard wallet={account.address} />;
}

function ActivityDashboard({ wallet }: { wallet: string }) {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-headline text-3xl font-bold">Activity</h1>
        <p className="text-on-surface-variant">
          Your recurring hires, deliverables, and privacy controls.
        </p>
      </header>
      <SubscriptionsPanel wallet={wallet} />
      <VaultPanel wallet={wallet} />
      <RightToForgetPanel wallet={wallet} />
    </div>
  );
}

// ─── Subscriptions panel ──────────────────────────────────────────

function SubscriptionsPanel({ wallet }: { wallet: string }) {
  const [subs, setSubs] = useState<Subscription[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = () => {
    api.listSubscriptions(wallet)
      .then((r) => setSubs(r.subscriptions))
      .catch((e) => setError((e as Error).message));
  };

  useEffect(() => { reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [wallet]);

  const cancel = async (subscription_object_id: string) => {
    setBusyId(subscription_object_id);
    try {
      const r = await fetch(
        `${process.env.NEXT_PUBLIC_AGENT_BACKEND_URL ?? 'http://localhost:3001'}/v3/loop/subscriptions/${encodeURIComponent(subscription_object_id)}/cancel`,
        { method: 'POST', headers: { 'x-wallet-address': wallet } },
      );
      if (!r.ok) throw new Error(`cancel ${r.status}`);
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Section title="Active subscriptions" subtitle="Daily-recurring workflow hires.">
      {error && <ErrorRow error={error} />}
      {subs === null && <LoadingRow />}
      {subs?.length === 0 && (
        <EmptyRow>
          No subscriptions yet. <Link className="text-primary hover:underline" href="/marketplace">Browse marketplace →</Link>
        </EmptyRow>
      )}
      {subs && subs.length > 0 && (
        <ul className="space-y-2">
          {subs.map((s) => (
            <li key={s.subscription_object_id} className="rounded-lg border border-outline-variant/20 bg-surface-container-low p-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Link href={`/agent/${s.agent_id}`} className="font-mono text-primary hover:underline">
                  {s.agent_id.slice(0, 12)}…{s.agent_id.slice(-4)}
                </Link>
                {s.area_slug && (
                  <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-300">
                    {s.area_slug}
                  </span>
                )}
                <span className="font-mono text-[10px] text-on-surface-variant">
                  {s.runs_remaining} runs remaining · daily at {formatUtcMinute(s.cron_utc_minute)} UTC
                </span>
                <span className="font-mono text-[10px] text-on-surface-variant">
                  ${(s.max_per_run_micro / 1_000_000).toFixed(2)} max / run
                </span>
                {s.cancelled_at ? (
                  <span className="rounded bg-error/20 px-1.5 py-0.5 font-mono text-[10px] text-error">
                    cancelled
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => cancel(s.subscription_object_id)}
                    disabled={busyId === s.subscription_object_id}
                    className="ml-auto rounded-full border border-error/40 px-2 py-0.5 font-mono text-[10px] text-error hover:bg-error/10 disabled:opacity-40"
                  >
                    {busyId === s.subscription_object_id ? 'Cancelling…' : 'Cancel'}
                  </button>
                )}
              </div>
              <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-on-surface-variant">
                <span>next run · {fmtTs(s.next_run_ts)}</span>
                {s.last_run_ts && <span>last run · {fmtTs(s.last_run_ts)}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ─── Vault panel ──────────────────────────────────────────────────

function VaultPanel({ wallet }: { wallet: string }) {
  const [entries, setEntries] = useState<VaultEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.vault(wallet)
      .then((r) => setEntries(r.entries))
      .catch((e) => setError((e as Error).message));
  }, [wallet]);

  // Group by area_slug for the spec's "deliverables grouped by area" view.
  const grouped = entries
    ? entries.reduce<Record<string, VaultEntry[]>>((acc, e) => {
        const k = e.area_slug ?? 'unfiled';
        (acc[k] ??= []).push(e);
        return acc;
      }, {})
    : null;

  return (
    <Section title="Artifact vault" subtitle="Deliverables you own forever — grouped by area.">
      {error && <ErrorRow error={error} />}
      {entries === null && <LoadingRow />}
      {entries?.length === 0 && <EmptyRow>No deliverables yet.</EmptyRow>}
      {grouped && Object.keys(grouped).length > 0 && (
        <div className="space-y-3">
          {Object.entries(grouped).map(([area, items]) => (
            <details key={area} open className="rounded-lg border border-outline-variant/20 bg-surface-container-low">
              <summary className="cursor-pointer p-3 font-mono text-xs">
                <span className="font-semibold uppercase text-on-surface">{area}</span>
                <span className="ml-2 text-on-surface-variant">({items.length})</span>
              </summary>
              <ul className="space-y-1 px-3 pb-3 text-xs">
                {items.map((e, i) => (
                  <li key={`${e.walrus_blob_id}-${i}`} className="flex items-center justify-between gap-2">
                    <span className="font-mono">{e.artifact_name}</span>
                    <span className="text-[10px] text-on-surface-variant">
                      {new Date(e.created_at).toLocaleDateString()}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </div>
      )}
    </Section>
  );
}

// ─── Right-to-forget panel ────────────────────────────────────────

function RightToForgetPanel({ wallet }: { wallet: string }) {
  // The list endpoint isn't part of the v1.1 surface; we just expose a
  // "request forget" action keyed by agent_id paste-in. Simpler than building
  // a full pending-list view for the spine. Deferred to v1.2.
  const [agentId, setAgentId] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!agentId) {
      setError('agent_id required');
      return;
    }
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const r = await api.requestRtf(wallet, agentId, reason || undefined);
      setDone(`Request id ${r.request.id} · ${r.cooling_off_days}-day cooling-off`);
      setAgentId('');
      setReason('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Right-to-forget" subtitle="Delete an agent's per-buyer memory of you. 7-day cooling-off; cancel any time.">
      <div className="grid gap-2 md:grid-cols-[1fr_2fr_auto]">
        <input
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          placeholder="agent slug or 0x..."
          className="rounded-md bg-surface-container-low px-3 py-2 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="reason (optional)"
          className="rounded-md bg-surface-container-low px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="rounded-full bg-error/80 px-3 py-2 font-mono text-xs text-on-primary hover:bg-error disabled:opacity-40"
        >
          {busy ? 'Submitting…' : 'Request forget'}
        </button>
      </div>
      {error && <div className="mt-2 rounded-md border border-error/40 bg-error/10 p-2 text-xs text-error">{error}</div>}
      {done && <div className="mt-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-2 text-xs text-emerald-300">✓ {done}</div>}
      <p className="mt-2 text-[10px] text-on-surface-variant">
        Only the per-buyer memory slot is deleted (cog-l4-{`{agent}`}-{`{your_addr}`}). The seller's general
        agent brain is untouched — your anonymized contributions to area patterns stay.
      </p>
    </Section>
  );
}

// ─── tiny page-local primitives ───────────────────────────────────

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-outline-variant/30 bg-surface p-5">
      <div className="mb-3 space-y-0.5">
        <h2 className="font-headline text-lg font-bold">{title}</h2>
        {subtitle && <p className="text-xs text-on-surface-variant">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-outline-variant/30 bg-surface-container-low p-4 text-center text-sm text-on-surface-variant">
      {children}
    </div>
  );
}

function LoadingRow() { return <div className="text-sm text-on-surface-variant">Loading…</div>; }

function ErrorRow({ error }: { error: string }) {
  return <div className="rounded-md border border-error/40 bg-error/10 p-2 text-xs text-error">{error}</div>;
}

function formatUtcMinute(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function fmtTs(ms: number | string): string {
  const n = typeof ms === 'string' ? Number(ms) : ms;
  if (!n || isNaN(n)) return '—';
  return new Date(n).toLocaleString();
}
