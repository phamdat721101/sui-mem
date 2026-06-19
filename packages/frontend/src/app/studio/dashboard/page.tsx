'use client';

/**
 * /studio/dashboard — seller-side on-chain command center.
 *
 * Aggregates published agents + on-chain stats + earnings + admin whitelist
 * controls (gated to operator wallet). Single page, single-pass fetch from
 * `/v3/loop/seller/me/onchain-stats` plus the existing seller dashboard
 * endpoint at `/v3/marketplace/seller/me`.
 *
 * SOLID:
 *   - SRP: presentation; aggregation lives in the BE endpoints.
 *   - DIP: shared explorer helper + bedrock catalog import — single sources.
 *   - OCP: a new stat = one tile + one BE field; layout is grid-driven.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useCurrentAccount, useSignAndExecuteTransaction } from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import { api } from '@/lib/api';
import { BEDROCK_MODEL_CATALOG } from '@fhe-ai-context/sui-sdk';

const ADMIN_ADDR = (process.env.NEXT_PUBLIC_OPENX_ADMIN_ADDRESS ?? '').toLowerCase();

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
  const [stats, setStats] = useState<StatsT | null>(null);
  const [seller, setSeller] = useState<Awaited<ReturnType<typeof api.sellerDashboard>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getSellerOnChainStats(wallet).then(setStats).catch((e) => setError((e as Error).message));
    api.sellerDashboard(wallet).then(setSeller).catch(() => setSeller(null));
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

      {isAdmin && <AdminWhitelistPanel wallet={wallet} />}
    </div>
  );
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
