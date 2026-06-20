'use client';

/**
 * /studio/dashboard — seller-side on-chain command center.
 *
 * Single-pane view of every on-chain artifact a seller cares about:
 *   1. Lifetime stat tiles (agents published, earned, fees, mutations).
 *   2. Your agents — slug + verification + lifetime earnings + drill-in.
 *   3. ON-CHAIN_ACTIVITY_LEDGER — per-event audit (Publish, Fee Paid,
 *      Pricing Updated, Manifest Updated, Revoked, etc.) with Suiscan
 *      deeplinks. Moved here from /settings so seller has one place to
 *      track every on-chain transaction.
 *   4. ACTIVE_HIRES — every WorkflowEscrow targeting the seller's agents
 *      (PRD workflow-escrow v2). One row per (agent × buyer × subscription)
 *      with status (active / stopped / cancelled / exhausted), runs left,
 *      and live escrow balance.
 *   5. Admin whitelist (admin wallet only).
 *
 * SOLID:
 *   - SRP: presentation; aggregation lives in BE endpoints. Status comes
 *     from the same `deriveStatus` source-of-truth used by /activity.
 *   - DIP: shared explorer helper + API client; never touches URLs.
 *   - OCP: a new stat = one tile + one BE field; layout is grid-driven.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useCurrentAccount, useSignAndExecuteTransaction } from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import { api, explorerTxUrl } from '@/lib/api';
import { BEDROCK_MODEL_CATALOG } from '@fhe-ai-context/sui-sdk';

const ADMIN_ADDR = (process.env.NEXT_PUBLIC_OPENX_ADMIN_ADDRESS ?? '').toLowerCase();
const NETWORK = process.env.NEXT_PUBLIC_SUI_NETWORK ?? 'sui-testnet';

export default function DashboardPage() {
  const account = useCurrentAccount();
  if (!account?.address) {
    return (
      <div className="mx-auto max-w-md rounded-xl border border-dashed border-outline-variant/40 bg-surface-container-low p-12 text-center">
        <h1 className="font-headline text-2xl font-bold">Connect to view dashboard</h1>
        <p className="mt-2 text-sm text-on-surface-variant">Sui wallet required.</p>
      </div>
    );
  }
  return <Dashboard wallet={account.address} />;
}

function Dashboard({ wallet }: { wallet: string }) {
  type StatsT = Awaited<ReturnType<typeof api.getSellerOnChainStats>>;
  type EventsT = Awaited<ReturnType<typeof api.getSellerWalletEvents>>['events'];
  const [stats, setStats] = useState<StatsT | null>(null);
  const [seller, setSeller] = useState<Awaited<ReturnType<typeof api.sellerDashboard>> | null>(null);
  const [events, setEvents] = useState<EventsT>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getSellerOnChainStats(wallet).then(setStats).catch((e) => setError((e as Error).message));
    api.sellerDashboard(wallet).then(setSeller).catch(() => setSeller(null));
    api.getSellerWalletEvents(wallet, 50).then((r) => setEvents(r.events)).catch(() => setEvents([]));
  }, [wallet]);

  const isAdmin = ADMIN_ADDR && wallet.toLowerCase() === ADMIN_ADDR;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header>
        <h1 className="font-headline text-3xl font-bold">Studio dashboard</h1>
        <p className="text-on-surface-variant">
          Lifetime on-chain activity for <code className="font-mono text-xs">{wallet.slice(0, 6)}…{wallet.slice(-4)}</code>.
          {isAdmin && <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-300">admin</span>}
        </p>
      </header>

      {error && <div className="rounded-md border border-error/40 bg-error/10 p-2 text-xs text-error">{error}</div>}

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Agents published" value={stats ? String(stats.on_chain.agents_published) : '…'} hint="on-chain LoopAgentPublished events" />
        <Stat label="Earned (USDC)" value={stats ? `$${formatUsdcDecimal(stats.earnings.earned_total_usdc)}` : '…'} hint={`${stats?.earnings.calls_total ?? 0} paid calls`} />
        <Stat label="Publish fees paid" value={stats ? `$${stats.on_chain.publish_fees_usdc.toFixed(2)}` : '…'} hint={`${stats?.on_chain.publish_fees_paid ?? 0} fee events`} />
        <Stat label="Mutations" value={stats ? String(stats.on_chain.mutations) : '…'} hint={`${stats?.on_chain.revocations ?? 0} revoked`} />
      </section>

      <section className="space-y-3">
        <h2 className="font-headline text-lg font-bold">Your agents</h2>
        {!seller && <div className="text-sm text-on-surface-variant">Loading…</div>}
        {seller && seller.agents.length === 0 && (
          <div className="rounded-lg border border-dashed border-outline-variant/30 bg-surface-container-low p-6 text-center text-sm text-on-surface-variant">
            No agents yet. <Link className="text-primary hover:underline" href="/studio/publish">Publish your first →</Link>
          </div>
        )}
        {seller && seller.agents.length > 0 && (
          <ul className="space-y-2">
            {seller.agents.map((a) => (
              <li key={a.id} className="rounded-lg border border-outline-variant/20 bg-surface-container-low p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Link href={`/agent/${a.slug}`} className="font-mono text-primary hover:underline">{a.slug}</Link>
                  <span className="rounded bg-surface-container px-1.5 py-0.5 font-mono text-[10px] text-on-surface-variant">{a.domain}</span>
                  <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] text-emerald-300">{a.verification_tier}</span>
                  {a.agent_object_id ? (
                    <span
                      className="rounded bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] text-emerald-300"
                      title={`On-chain Agent ${a.agent_object_id.slice(0, 8)}…${a.agent_object_id.slice(-6)} — buyers can hire & escrow`}
                    >
                      ✓ on-chain
                    </span>
                  ) : (
                    <span
                      className="rounded bg-amber-500/20 px-1.5 py-0.5 font-mono text-[10px] text-amber-300"
                      title="No LoopAgentPublished event indexed yet. Buyers will see 'Off-chain only · cannot escrow yet' on the agent page. Re-run the on-chain publish PTB or wait for the indexer to catch up."
                    >
                      ⚠ off-chain
                    </span>
                  )}
                  <span className="font-mono text-[10px] text-on-surface-variant">
                    earned ${formatUsdcDecimal(a.earned_total)} · {a.calls_total} calls
                  </span>
                  <Link
                    href={`/studio/agents/${encodeURIComponent(a.slug)}/activity`}
                    className="ml-auto rounded-full border border-primary/40 px-2 py-0.5 font-mono text-[10px] text-primary hover:bg-primary/10"
                  >
                    on-chain activity →
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ActivityLedger events={events} />
      <ActiveHires wallet={wallet} dash={seller} />

      {isAdmin && <AdminWhitelistPanel wallet={wallet} />}
    </div>
  );
}

// ─── ON-CHAIN_ACTIVITY_LEDGER (lifted from /settings) ────────────────
//
// Per-event audit table. One row per indexed agent_event for this wallet,
// every row deeplinked to Suiscan via the shared `explorerTxUrl` helper so
// no URL strings live in components.

const EVENT_LABEL: Record<string, string> = {
  LoopAgentPublished:    'Agent Published',
  AgentPublishFeePaid:   'Fee Paid',
  AgentPricingUpdated:   'Pricing Updated',
  AgentModelUpdated:     'Model Updated',
  AgentManifestUpdated:  'Manifest Updated',
  AgentManifestAttested: 'Manifest Attested',
  LoopAgentRevoked:      'Agent Revoked',
  LoopAgentReputationUpdated: 'Reputation Updated',
  BedrockModelWhitelisted:    'Model Whitelisted',
  BedrockModelDelisted:       'Model Delisted',
};

function ActivityLedger({
  events,
}: {
  events: Awaited<ReturnType<typeof api.getSellerWalletEvents>>['events'];
}) {
  return (
    <section className="rounded-xl border border-outline-variant/30 bg-surface p-5 space-y-3">
      <header>
        <h2 className="font-headline text-lg font-bold">On-chain activity</h2>
        <p className="text-xs text-on-surface-variant">Every agent_events row for your wallet, newest first.</p>
      </header>
      {events.length === 0 ? (
        <p className="text-[11px] text-on-surface-variant">No events yet. Publish or update an agent to see history here.</p>
      ) : (
        <div className="-mx-5 overflow-x-auto md:mx-0">
          <table className="w-full min-w-[560px] text-[11px]">
            <thead>
              <tr className="text-left text-[10px] uppercase text-on-surface-variant">
                <th className="px-5 pb-2 font-normal md:px-0">Event</th>
                <th className="px-2 pb-2 font-normal md:px-0">Type</th>
                <th className="px-2 pb-2 text-right font-normal md:px-0">Amount</th>
                <th className="px-2 pb-2 text-right font-normal md:px-0">Status</th>
                <th className="px-5 pb-2 text-right font-normal md:px-0">Explorer</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => {
                const explorer = explorerTxUrl(NETWORK, e.tx_digest);
                const amount = formatEventAmount(e.type, e.payload);
                const typeBadge = e.type.startsWith('AgentPublishFeePaid') || e.type.includes('Pricing') ? 'USDC' : 'SUI';
                return (
                  <tr key={`${e.tx_digest}-${e.seq_in_tx}`} className="border-t border-outline-variant/10">
                    <td className="whitespace-nowrap px-5 py-2 text-on-surface md:px-0">{EVENT_LABEL[e.type] ?? e.type}</td>
                    <td className="whitespace-nowrap px-2 py-2 font-mono text-primary md:px-0">{typeBadge}</td>
                    <td className="whitespace-nowrap px-2 py-2 text-right font-mono text-on-surface md:px-0">{amount ?? '—'}</td>
                    <td className="whitespace-nowrap px-2 py-2 text-right text-emerald-300 md:px-0">CONFIRMED</td>
                    <td className="whitespace-nowrap px-5 py-2 text-right md:px-0">
                      {explorer ? (
                        <a href={explorer} target="_blank" rel="noreferrer" className="font-mono text-primary hover:underline">
                          {e.tx_digest.slice(0, 6)}…{e.tx_digest.slice(-4)} ↗
                        </a>
                      ) : (
                        <span className="font-mono text-on-surface-variant">{e.tx_digest.slice(0, 6)}…</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function formatEventAmount(type: string, payload: Record<string, unknown>): string | null {
  if (type === 'AgentPublishFeePaid') {
    const fee = Number(payload.fee_micro ?? 0);
    return Number.isFinite(fee) ? `$${(fee / 1e6).toFixed(2)}` : null;
  }
  if (type === 'AgentPricingUpdated') {
    const v = Number(payload.new_per_iter_default ?? 0);
    return Number.isFinite(v) ? `$${(v / 1e6).toFixed(4)}/call` : null;
  }
  return null;
}

// ─── ACTIVE_HIRES (lifted from /settings — workflow-escrow v2) ───────
//
// One row per (agent × buyer × subscription) showing budget + status.
// Status comes from the `/v3/loop/seller/agents/:id/subscribers` endpoint
// which uses the same `deriveStatus` helper as the buyer-side /activity.

function ActiveHires({
  wallet,
  dash,
}: {
  wallet: string;
  dash: Awaited<ReturnType<typeof api.sellerDashboard>> | null;
}) {
  type Row = Awaited<ReturnType<typeof api.sellerAgentSubscribers>>['subscribers'][number] & { agent_slug: string };
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!dash || dash.agents.length === 0) { setRows([]); return; }
    let cancelled = false;
    Promise.all(
      dash.agents.map((a) =>
        api.sellerAgentSubscribers(wallet, a.id)
          .then((r) => r.subscribers.map((s) => ({ ...s, agent_slug: a.slug })))
          .catch(() => [] as Row[]),
      ),
    )
      .then((batches) => { if (!cancelled) setRows(batches.flat()); })
      .catch((e) => { if (!cancelled) setError((e as Error).message); });
    return () => { cancelled = true; };
  }, [wallet, dash]);

  return (
    <section className="rounded-xl border border-outline-variant/30 bg-surface p-5 space-y-3">
      <header>
        <h2 className="font-headline text-lg font-bold">Active hires</h2>
        <p className="text-xs text-on-surface-variant">Every WorkflowEscrow targeting your agents — live status &amp; budget.</p>
      </header>
      {error && <p className="text-[11px] text-error">{error}</p>}
      {rows === null && <p className="text-[11px] text-on-surface-variant">Loading hires…</p>}
      {rows?.length === 0 && (
        <p className="text-[11px] text-on-surface-variant">No active hires yet — your agents haven&apos;t been subscribed to.</p>
      )}
      {rows && rows.length > 0 && (
        <div className="-mx-5 overflow-x-auto md:mx-0">
          <table className="w-full min-w-[640px] text-[11px]">
            <thead>
              <tr className="text-left text-[10px] uppercase text-on-surface-variant">
                <th className="px-5 pb-2 font-normal md:px-0">Agent</th>
                <th className="px-2 pb-2 font-normal md:px-0">Buyer</th>
                <th className="px-2 pb-2 font-normal md:px-0">Status</th>
                <th className="px-2 pb-2 text-right font-normal md:px-0">Runs</th>
                <th className="px-2 pb-2 text-right font-normal md:px-0">Escrow</th>
                <th className="px-2 pb-2 text-right font-normal md:px-0">Total</th>
                <th className="px-5 pb-2 text-right font-normal md:px-0">Next run</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.subscription_object_id} className="border-t border-outline-variant/10">
                  <td className="whitespace-nowrap px-5 py-2 font-mono text-primary md:px-0">{r.agent_slug}</td>
                  <td className="whitespace-nowrap px-2 py-2 font-mono text-on-surface md:px-0">
                    {r.buyer_addr.slice(0, 6)}…{r.buyer_addr.slice(-4)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 md:px-0"><HireStatusPill status={r.status} /></td>
                  <td className="whitespace-nowrap px-2 py-2 text-right font-mono text-on-surface md:px-0">{r.runs_remaining}</td>
                  <td className="whitespace-nowrap px-2 py-2 text-right font-mono text-on-surface md:px-0">
                    ${(Number(r.escrow_remaining_micro) / 1_000_000).toFixed(2)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 text-right font-mono text-on-surface-variant md:px-0">
                    ${(Number(r.total_escrowed_micro) / 1_000_000).toFixed(2)}
                  </td>
                  <td className="whitespace-nowrap px-5 py-2 text-right font-mono text-on-surface-variant md:px-0">
                    {r.cancelled_at ? '—' : new Date(Number(r.next_run_ts)).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function HireStatusPill({ status }: { status: 'active' | 'stopped' | 'cancelled' | 'exhausted' }) {
  const cls =
    status === 'active'    ? 'bg-emerald-500/15 text-emerald-300' :
    status === 'stopped'   ? 'bg-amber-500/20 text-amber-300' :
    status === 'cancelled' ? 'bg-error/20 text-error' :
                             'bg-on-surface/10 text-on-surface-variant';
  return <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ${cls}`}>{status}</span>;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-outline-variant/30 bg-surface p-4">
      <div className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">{label}</div>
      <div className="mt-1 font-headline text-2xl font-bold">{value}</div>
      {hint && <div className="font-mono text-[10px] text-on-surface-variant">{hint}</div>}
    </div>
  );
}

function AdminWhitelistPanel({ wallet }: { wallet: string }) {
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [customId, setCustomId] = useState('');

  const run = async (action: 'add' | 'remove', model_id: string) => {
    setBusy(`${action}:${model_id}`);
    setErr(null); setMsg(null);
    try {
      const r = action === 'add'
        ? await api.adminWhitelistModel(wallet, model_id)
        : await api.adminRemoveWhitelistModel(wallet, model_id);
      const tx = Transaction.from(Buffer.from(r.ptb_bytes_b64, 'base64'));
      const result = await signAndExecute({ transaction: tx as unknown as Parameters<typeof signAndExecute>[0]['transaction'] });
      setMsg(`✓ ${action} ${model_id} · tx ${result.digest.slice(0, 10)}…`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-5 space-y-3">
      <header>
        <h2 className="font-headline text-lg font-bold text-amber-300">Admin · Bedrock whitelist</h2>
        <p className="text-xs text-on-surface-variant">Sign the PTB to add/remove a model from the on-chain registry. Sellers immediately see the change in the publish wizard.</p>
      </header>
      {err && <div className="rounded-md border border-error/40 bg-error/10 p-2 text-xs text-error">{err}</div>}
      {msg && <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-2 text-xs text-emerald-300">{msg}</div>}

      <ul className="space-y-1.5">
        {BEDROCK_MODEL_CATALOG.map((m) => (
          <li key={m.id} className="flex items-center gap-2 text-xs">
            <span className="rounded bg-surface-container px-1.5 py-0.5 font-mono text-[10px]">{m.tier}</span>
            <span className="font-mono">{m.label}</span>
            <code className="font-mono text-[10px] text-on-surface-variant">{m.id}</code>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => run('add', m.id)}
              className="ml-auto rounded-full border border-emerald-500/40 px-2 py-0.5 font-mono text-[10px] text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-40"
            >
              {busy === `add:${m.id}` ? '…' : 'Whitelist'}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => run('remove', m.id)}
              className="rounded-full border border-error/40 px-2 py-0.5 font-mono text-[10px] text-error hover:bg-error/10 disabled:opacity-40"
            >
              {busy === `remove:${m.id}` ? '…' : 'Remove'}
            </button>
          </li>
        ))}
      </ul>

      <div className="flex items-center gap-2 border-t border-outline-variant/20 pt-3">
        <input
          value={customId}
          onChange={(e) => setCustomId(e.target.value)}
          placeholder="custom model id"
          className="flex-1 rounded-md border border-outline-variant/30 bg-surface-container-low px-2 py-1 font-mono text-xs"
        />
        <button
          type="button"
          disabled={!customId || busy !== null}
          onClick={() => run('add', customId)}
          className="rounded-full bg-amber-500/80 px-3 py-1 font-mono text-xs text-on-primary disabled:opacity-40"
        >
          Whitelist custom
        </button>
      </div>
    </section>
  );
}

function formatUsdcDecimal(s: string | number): string {
  const n = typeof s === 'string' ? Number(s) : s;
  if (!Number.isFinite(n)) return '0.00';
  return n.toFixed(2);
}
