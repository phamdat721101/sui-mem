'use client';

/**
 * /activity — buyer ops dashboard (PRD-W v1.2).
 *
 * Four panels (top to bottom):
 *   1. Active subscriptions   — recurring hires + status badge per sub
 *   2. Weekly digest          — auto-synthesized markdown summary (Sunday cron)
 *   3. Run timeline           — per-run cards with downloads + drawer
 *   4. Right-to-forget        — buyer-initiated 7d cooling-off delete
 *
 * SOLID:
 *   - SRP: this file is presentation only; data shapes come from `@/lib/api`.
 *   - DIP: every fetch goes through `api.*`; no page hard-codes URL strings.
 *   - OCP: a fifth panel = one new section, no other change.
 *
 * Feature flag (NEXT_PUBLIC_FEATURE_LOOP_RUN_TIMELINE):
 *   - unset / anything ≠ 'false' → RunTimelinePanel + WeeklyDigestCard (default).
 *   - 'false'                    → LegacyVaultPanel (emergency rollback only).
 *
 * Default-on rationale: PRD-W v1.2 timeline UI has shipped. Vercel deploys
 * shouldn't need extra env config to get the canonical product surface.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import { api, walrusViewUrl, isPlaceholderBlob, vaultDownload, type RunGroup, type RunStatus } from '@/lib/api';

const FEATURE_TIMELINE = process.env.NEXT_PUBLIC_FEATURE_LOOP_RUN_TIMELINE !== 'false';

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
  // v2 escrow surfaces; legacy v1 rows have these undefined.
  escrow_remaining_micro?: string;
  total_escrowed_micro?: string;
  package_version?: number;
  status?: 'active' | 'stopped' | 'cancelled' | 'exhausted';
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
  // Single-source-of-truth fetch for runs — both the timeline panel AND the
  // subscription status badges read from this. SOLID-DIP: one network call,
  // two consumers, zero duplicate fetches.
  const [runs, setRuns] = useState<RunGroup[] | null>(null);

  useEffect(() => {
    if (!FEATURE_TIMELINE) return;
    let cancelled = false;
    const load = () =>
      api.listRuns(wallet)
        .then((r) => { if (!cancelled) setRuns(r.runs); })
        .catch(() => { if (!cancelled) setRuns([]); });
    load();
    const t = setInterval(load, 30_000); // 30s SWR-style polling
    return () => { cancelled = true; clearInterval(t); };
  }, [wallet]);

  const latestStatusByAgent = useMemo(() => {
    const map = new Map<string, RunStatus>();
    if (!runs) return map;
    for (const run of runs) {
      const agent = run.agent_id;
      if (!agent || map.has(agent)) continue; // runs are DESC-sorted; first wins
      map.set(agent, run.run_status);
    }
    return map;
  }, [runs]);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-headline text-3xl font-bold">Activity</h1>
        <p className="text-on-surface-variant">
          Your recurring hires, deliverables, and privacy controls.
        </p>
      </header>
      <SubscriptionsPanel wallet={wallet} statusByAgent={latestStatusByAgent} />
      {FEATURE_TIMELINE ? (
        <>
          <WeeklyDigestCard wallet={wallet} />
          <RunTimelinePanel wallet={wallet} runs={runs} />
        </>
      ) : (
        <LegacyVaultPanel wallet={wallet} />
      )}
      <RightToForgetPanel wallet={wallet} />
    </div>
  );
}

// ─── Subscriptions panel ──────────────────────────────────────────

function SubscriptionsPanel({
  wallet,
  statusByAgent,
}: {
  wallet: string;
  statusByAgent: Map<string, RunStatus>;
}) {
  const client = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const [subs, setSubs] = useState<Subscription[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [topUpFor, setTopUpFor] = useState<string | null>(null);

  const reload = () => {
    api.listSubscriptions(wallet)
      .then((r) => setSubs(r.subscriptions))
      .catch((e) => setError((e as Error).message));
  };

  useEffect(() => { reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [wallet]);

  /**
   * Cancel — v2 returns a PTB the buyer signs (refund hits the wallet on
   * chain); v1 returns `{ ok: true }` from a DB-only cancel. The same FE
   * helper handles both: if `ptb_bytes_b64` is present we sign + execute,
   * otherwise we just refresh.
   */
  const cancel = async (s: Subscription) => {
    setError(null);
    setBusyId(s.subscription_object_id);
    try {
      const r = await api.buildCancelSubscription(wallet, s.subscription_object_id);
      if (r.ptb_bytes_b64) {
        const txBytes = Uint8Array.from(atob(r.ptb_bytes_b64), (c) => c.charCodeAt(0));
        const signed = await signAndExecute({
          transaction: Transaction.from(txBytes) as unknown as Parameters<typeof signAndExecute>[0]['transaction'],
        });
        await client.waitForTransaction({ digest: signed.digest, timeout: 30_000 }).catch(() => undefined);
      }
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  /** Top up an existing v2 escrow with `runs_to_add` more runs of budget. */
  const topUp = async (s: Subscription, runs_to_add: number) => {
    setError(null);
    setBusyId(s.subscription_object_id);
    try {
      const cfg = await api.getSellerV2Config().catch(() => null);
      const usdcCoinType = cfg?.usdc_coin_type;
      if (!usdcCoinType) throw new Error('USDC coin type not configured');
      const needed = BigInt(runs_to_add) * BigInt(s.max_per_run_micro);
      const coins = await client.getCoins({ owner: wallet, coinType: usdcCoinType, limit: 50 });
      const coin = coins.data.find((c) => BigInt(c.balance) >= needed);
      if (!coin) {
        throw new Error(`Need $${(Number(needed) / 1e6).toFixed(2)} USDC in a single coin`);
      }
      const r = await api.buildTopUpPtb(wallet, s.subscription_object_id, {
        runs_to_add,
        budget_coin_object_id: coin.coinObjectId,
      });
      const txBytes = Uint8Array.from(atob(r.ptb_bytes_b64), (c) => c.charCodeAt(0));
      const signed = await signAndExecute({
        transaction: Transaction.from(txBytes) as unknown as Parameters<typeof signAndExecute>[0]['transaction'],
      });
      await client.waitForTransaction({ digest: signed.digest, timeout: 30_000 }).catch(() => undefined);
      setTopUpFor(null);
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
          {subs.map((s) => {
            const runStatus = statusByAgent.get(s.agent_id);
            const escrowStatus = s.status ?? (s.cancelled_at ? 'cancelled' : 'active');
            const isV2 = (s.package_version ?? 1) === 2;
            const isStopped = escrowStatus === 'stopped';
            const isActive = escrowStatus === 'active';
            return (
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
                  <EscrowStatusBadge status={escrowStatus} />
                  {runStatus && <SubscriptionStatusBadge status={runStatus} />}
                  <span className="font-mono text-[10px] text-on-surface-variant">
                    {s.runs_remaining} runs · daily at {formatUtcMinute(s.cron_utc_minute)} UTC
                  </span>
                  <span className="font-mono text-[10px] text-on-surface-variant">
                    ${(s.max_per_run_micro / 1_000_000).toFixed(2)} / run
                  </span>
                  {s.escrow_remaining_micro != null && (
                    <span className="font-mono text-[10px] text-on-surface-variant">
                      escrow ${(Number(s.escrow_remaining_micro) / 1_000_000).toFixed(2)}
                    </span>
                  )}
                  <div className="ml-auto flex items-center gap-1.5">
                    {isV2 && (isActive || isStopped) && (
                      <button
                        type="button"
                        onClick={() => setTopUpFor(topUpFor === s.subscription_object_id ? null : s.subscription_object_id)}
                        disabled={busyId === s.subscription_object_id}
                        className={`rounded-full border px-2 py-0.5 font-mono text-[10px] disabled:opacity-40 ${
                          isStopped
                            ? 'border-amber-500/60 bg-amber-500/15 text-amber-300 hover:bg-amber-500/25'
                            : 'border-primary/40 text-primary hover:bg-primary/10'
                        }`}
                      >
                        {isStopped ? 'Top up to restart' : 'Top up'}
                      </button>
                    )}
                    {!s.cancelled_at && (
                      <button
                        type="button"
                        onClick={() => cancel(s)}
                        disabled={busyId === s.subscription_object_id}
                        className="rounded-full border border-error/40 px-2 py-0.5 font-mono text-[10px] text-error hover:bg-error/10 disabled:opacity-40"
                      >
                        {busyId === s.subscription_object_id ? 'Working…' : isStopped ? 'Cancel & refund' : 'Cancel'}
                      </button>
                    )}
                  </div>
                </div>
                <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-on-surface-variant">
                  <span>next run · {fmtTs(s.next_run_ts)}</span>
                  {s.last_run_ts && <span>last run · {fmtTs(s.last_run_ts)}</span>}
                </div>

                {/* Inline top-up form. Same layout idiom as the Cancel button. */}
                {topUpFor === s.subscription_object_id && (
                  <TopUpInlineForm
                    busy={busyId === s.subscription_object_id}
                    perRunUsd={s.max_per_run_micro / 1_000_000}
                    onSubmit={(n) => topUp(s, n)}
                    onClose={() => setTopUpFor(null)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

/**
 * Read-only badge that mirrors the four states from `services/loop/escrowStatus`.
 * Same color palette as the run-status badges so the two reads side-by-side.
 */
function EscrowStatusBadge({ status }: { status: 'active' | 'stopped' | 'cancelled' | 'exhausted' }) {
  const cls =
    status === 'active'    ? 'bg-emerald-500/15 text-emerald-300' :
    status === 'stopped'   ? 'bg-amber-500/20 text-amber-300' :
    status === 'cancelled' ? 'bg-error/20 text-error' :
                             'bg-on-surface/10 text-on-surface-variant';
  return (
    <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ${cls}`}>{status}</span>
  );
}

/**
 * Inline +N form for topping up a stopped/active escrow. Single input;
 * computes the on-chain charge from `runs_to_add * per_run`. Closes itself
 * on submit/cancel.
 */
function TopUpInlineForm({
  busy, perRunUsd, onSubmit, onClose,
}: {
  busy: boolean; perRunUsd: number;
  onSubmit: (runs_to_add: number) => void;
  onClose: () => void;
}) {
  const [n, setN] = useState(7);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-outline-variant/30 bg-background p-2 text-[11px]">
      <span className="font-mono uppercase text-on-surface-variant">runs to add</span>
      <input
        type="number" min={1} max={366}
        value={n}
        onChange={(e) => setN(Math.max(1, Math.min(366, Number(e.target.value) || 1)))}
        className="w-16 rounded bg-surface-container-low px-2 py-1 font-mono"
        disabled={busy}
      />
      <span className="font-mono text-on-surface-variant">
        = ${(n * perRunUsd).toFixed(2)} USDC
      </span>
      <button
        type="button"
        onClick={() => onSubmit(n)}
        disabled={busy || n < 1}
        className="ml-auto rounded-full bg-primary px-3 py-1 text-[10px] font-mono uppercase text-on-primary disabled:opacity-40"
      >
        {busy ? 'Signing…' : `Top up (${n})`}
      </button>
      <button
        type="button"
        onClick={onClose}
        disabled={busy}
        className="rounded-full border border-outline-variant/40 px-2 py-1 text-[10px] font-mono uppercase text-on-surface-variant"
      >
        Close
      </button>
    </div>
  );
}

// ─── Weekly digest card (PRD-W v1.2) ──────────────────────────────

function WeeklyDigestCard({ wallet }: { wallet: string }) {
  const [digest, setDigest] = useState<Awaited<ReturnType<typeof api.getDigest>>['digest']>(null);
  const [body, setBody] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getDigest(wallet).then((r) => setDigest(r.digest)).catch(() => setDigest(null));
  }, [wallet]);

  if (!digest) return null;

  const view = async () => {
    if (body) { setOpen((o) => !o); return; }
    setBusy(true);
    try {
      const url = walrusViewUrl(digest.walrus_blob_id);
      if (!url) {
        setBody('# Error\n\nDigest blob is unavailable (placeholder id).');
        setOpen(true);
        return;
      }
      const r = await fetch(url);
      const text = await r.text();
      setBody(text);
      setOpen(true);
    } catch (e) {
      setBody(`# Error\n\nFailed to fetch digest: ${(e as Error).message}`);
      setOpen(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title={`Weekly digest · ${digest.week}`}
      subtitle="Auto-synthesized from this week's runs. Metadata-only — your artifact contents are never read by the synthesizer."
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={view}
          disabled={busy}
          className="rounded-full border border-primary/40 px-3 py-1 font-mono text-xs text-primary hover:bg-primary/10 disabled:opacity-40"
        >
          {busy ? 'Loading…' : open ? 'Hide' : 'View'}
        </button>
        <a
          href={walrusViewUrl(digest.walrus_blob_id) ?? '#'}
          target="_blank"
          rel="noopener noreferrer"
          aria-disabled={isPlaceholderBlob(digest.walrus_blob_id)}
          className="rounded-full border border-outline-variant/40 px-3 py-1 font-mono text-xs text-on-surface-variant hover:bg-surface-container"
        >
          Download .md
        </a>
        <span className="ml-auto font-mono text-[10px] text-on-surface-variant">
          generated · {fmtTs(digest.created_at)}
        </span>
      </div>
      {open && body && (
        <pre className="mt-3 max-h-96 overflow-auto rounded-md bg-surface-container-low p-3 text-[11px] leading-relaxed">
          {body}
        </pre>
      )}
    </Section>
  );
}

// ─── Run timeline panel + cards + drawer ──────────────────────────

function RunTimelinePanel({ wallet, runs }: { wallet: string; runs: RunGroup[] | null }) {
  const [filterArea, setFilterArea] = useState<string>('');
  const [filterStatus, setFilterStatus] = useState<string>('');
  const [drawerJobId, setDrawerJobId] = useState<string | null>(null);

  const areas = useMemo(() => {
    const set = new Set<string>();
    runs?.forEach((r) => { if (r.area_slug) set.add(r.area_slug); });
    return [...set];
  }, [runs]);

  const filtered = useMemo(() => {
    if (!runs) return null;
    return runs.filter((r) => {
      if (filterArea && r.area_slug !== filterArea) return false;
      if (filterStatus && r.run_status !== filterStatus) return false;
      return true;
    });
  }, [runs, filterArea, filterStatus]);

  const drawerRun = useMemo(
    () => (drawerJobId && runs ? runs.find((r) => r.job_id === drawerJobId) ?? null : null),
    [drawerJobId, runs],
  );

  return (
    <Section title="Run timeline" subtitle="Daily-recurring deliverables grouped by run. Click a run for downloads.">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <select
          value={filterArea}
          onChange={(e) => setFilterArea(e.target.value)}
          className="rounded-md bg-surface-container-low px-2 py-1 font-mono text-xs"
        >
          <option value="">all areas</option>
          {areas.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="rounded-md bg-surface-container-low px-2 py-1 font-mono text-xs"
        >
          <option value="">all statuses</option>
          <option value="success">success</option>
          <option value="running">running</option>
          <option value="pending">pending</option>
          <option value="failed">failed</option>
          <option value="completed">completed</option>
        </select>
        <span className="ml-auto font-mono text-[10px] text-on-surface-variant">
          {filtered?.length ?? '…'} run{(filtered?.length ?? 0) === 1 ? '' : 's'}
        </span>
      </div>

      {runs === null && <LoadingRow />}
      {runs?.length === 0 && (
        <EmptyRow>
          No runs yet. Your subscription's first run will appear here after the next cron tick.
        </EmptyRow>
      )}
      {filtered && filtered.length > 0 && (
        <ul className="space-y-2">
          {filtered.map((run) => (
            <RunTimelineCard
              key={run.job_id}
              run={run}
              onOpen={() => setDrawerJobId(run.job_id)}
            />
          ))}
        </ul>
      )}

      {drawerRun && (
        <RunDetailDrawer run={drawerRun} onClose={() => setDrawerJobId(null)} />
      )}
    </Section>
  );
}

function RunTimelineCard({ run, onOpen }: { run: RunGroup; onOpen: () => void }) {
  const cost = run.total_cost_micro != null ? `$${(run.total_cost_micro / 1e6).toFixed(2)}` : '—';
  return (
    <li>
      <article
        onClick={onOpen}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onOpen(); }}
        className="cursor-pointer rounded-lg border border-outline-variant/20 bg-surface-container-low p-3 hover:bg-surface-container"
      >
        <header className="flex flex-wrap items-center gap-2 text-xs">
          <SubscriptionStatusBadge status={run.run_status} />
          <span className="font-mono text-[11px]">{fmtTs(run.run_started_at)}</span>
          {run.area_slug && (
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-300">
              {run.area_slug}
            </span>
          )}
          <span className="font-mono text-[10px] text-on-surface-variant">
            {run.artifacts.length} artifact{run.artifacts.length === 1 ? '' : 's'} · {cost}
          </span>
          <a
            href={api.bundleUrl(run.job_id)}
            onClick={(e) => e.stopPropagation()}
            className="ml-auto rounded-full border border-primary/40 px-2 py-0.5 font-mono text-[10px] text-primary hover:bg-primary/10"
          >
            Download all
          </a>
        </header>
        <div className="mt-1 flex flex-wrap gap-1">
          {run.artifacts.slice(0, 5).map((a) => (
            <span key={a.walrus_blob_id} className="rounded bg-surface-container px-1.5 py-0.5 font-mono text-[10px]">
              {a.artifact_name}
            </span>
          ))}
          {run.artifacts.length > 5 && (
            <span className="text-[10px] text-on-surface-variant">
              +{run.artifacts.length - 5} more
            </span>
          )}
        </div>
      </article>
    </li>
  );
}

function RunDetailDrawer({ run, onClose }: { run: RunGroup; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-40 flex" onClick={onClose}>
      <div className="flex-1 bg-black/40" />
      <aside
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-md flex-col gap-3 overflow-y-auto bg-surface p-5 shadow-xl"
      >
        <header className="flex items-center justify-between">
          <h3 className="font-headline text-lg font-bold">Run · {run.job_id.slice(0, 16)}…</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-outline-variant/30 px-2 py-0.5 font-mono text-xs text-on-surface-variant hover:bg-surface-container"
          >
            Close
          </button>
        </header>
        <div className="flex flex-wrap items-center gap-2 text-xs text-on-surface-variant">
          <SubscriptionStatusBadge status={run.run_status} />
          <span className="font-mono">{fmtTs(run.run_started_at)}</span>
          {run.area_slug && (
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-300">
              {run.area_slug}
            </span>
          )}
          <span className="font-mono text-[10px]">
            {run.step_count ?? 0} steps · {run.total_cost_micro != null ? `$${(run.total_cost_micro / 1e6).toFixed(2)}` : '—'}
          </span>
        </div>
        <a
          href={api.bundleUrl(run.job_id)}
          className="rounded-full bg-primary px-3 py-2 text-center font-mono text-xs text-on-primary hover:bg-primary/90"
        >
          Download all as ZIP
        </a>
        <h4 className="mt-2 font-mono text-[11px] uppercase text-on-surface-variant">Artifacts</h4>
        <ul className="space-y-1.5">
          {run.artifacts.map((a) => {
            const url = walrusViewUrl(a.walrus_blob_id);
            const e2ee = a.artifact_name.endsWith('.encrypted') || a.mime_type === 'application/x-encrypted';
            return (
              <li key={a.walrus_blob_id} className="flex items-center justify-between gap-2 rounded-md border border-outline-variant/20 bg-surface-container-low px-2 py-1.5">
                <div className="flex flex-col">
                  {url ? (
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-xs text-primary hover:underline"
                    >
                      {a.artifact_name}
                    </a>
                  ) : (
                    <span className="font-mono text-xs text-on-surface-variant" title="Blob not yet pinned to Walrus">
                      {a.artifact_name}
                    </span>
                  )}
                  <span className="font-mono text-[10px] text-on-surface-variant">{a.mime_type}</span>
                </div>
                {e2ee && (
                  <span className="rounded bg-purple-500/15 px-1.5 py-0.5 font-mono text-[10px] text-purple-300">
                    🔒 E2EE
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        {(() => {
          const wfUrl = walrusViewUrl(run.workflow_walrus_blob_id);
          if (!wfUrl) return null;
          return (
            <a
              href={wfUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 text-center font-mono text-[10px] text-on-surface-variant hover:underline"
            >
              View workflow YAML on Walrus →
            </a>
          );
        })()}
      </aside>
    </div>
  );
}

// ─── Status badge ─────────────────────────────────────────────────

function SubscriptionStatusBadge({ status }: { status: RunStatus }) {
  const map: Record<RunStatus, { label: string; cls: string }> = {
    success:   { label: '✓ success',   cls: 'bg-emerald-500/15 text-emerald-300' },
    running:   { label: '⟳ running',   cls: 'bg-primary/15 text-primary animate-pulse' },
    pending:   { label: '… pending',   cls: 'bg-surface-container text-on-surface-variant' },
    failed:    { label: '✗ failed',    cls: 'bg-error/15 text-error' },
    completed: { label: '· completed', cls: 'bg-emerald-500/10 text-emerald-300' },
  };
  const { label, cls } = map[status];
  return (
    <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${cls}`}>
      {label}
    </span>
  );
}

// ─── Legacy vault panel (FEATURE_LOOP_RUN_TIMELINE=false) ─────────

function LegacyVaultPanel({ wallet }: { wallet: string }) {
  const [entries, setEntries] = useState<VaultEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.vault(wallet)
      .then((r) => setEntries(r.entries))
      .catch((e) => setError((e as Error).message));
  }, [wallet]);

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
                    <VaultArtifactName wallet={wallet} entry={e} />
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

/**
 * Artifact name rendered as a download button. Uses the API proxy
 * (`vaultDownload`) which works in every browser context (Vercel + dev),
 * not direct Walrus aggregator URLs which are fragile in production.
 *
 * Placeholder blobs (`pending-…`, `stub-…`) render as disabled labels —
 * the seller hasn't pinned the artifact yet, so there's nothing to fetch.
 */
function VaultArtifactName({ wallet, entry }: {
  wallet: string;
  entry: { artifact_name: string; walrus_blob_id: string };
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const placeholder = isPlaceholderBlob(entry.walrus_blob_id);

  if (placeholder) {
    return (
      <span
        className="font-mono text-on-surface-variant"
        title="Artifact not pinned to Walrus yet"
      >
        {entry.artifact_name} <span className="text-[10px]">· pending</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setErr(null);
        setBusy(true);
        try { await vaultDownload(wallet, entry.walrus_blob_id, entry.artifact_name); }
        catch (e) { setErr((e as Error).message); }
        finally { setBusy(false); }
      }}
      className="font-mono text-on-surface hover:text-primary disabled:opacity-50"
      title={err ? `Failed: ${err}` : `Download ${entry.artifact_name}`}
    >
      {entry.artifact_name} {busy ? '↓…' : '↓'}
    </button>
  );
}

// ─── Right-to-forget panel ────────────────────────────────────────

function RightToForgetPanel({ wallet }: { wallet: string }) {
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

function fmtTs(ms: number | string | null | undefined): string {
  if (ms == null || ms === '') return '—';
  const n = typeof ms === 'string' ? (Number.isFinite(Number(ms)) && /^\d+$/.test(ms) ? Number(ms) : Date.parse(ms)) : ms;
  if (!Number.isFinite(n)) return '—';
  return new Date(n).toLocaleString();
}
