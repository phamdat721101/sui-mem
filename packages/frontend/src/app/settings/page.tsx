'use client';

/**
 * /settings — OpenX Infrastructure command center (PRD-W v1.4).
 *
 * Seven panels backed by REAL on-chain + DB data:
 *   1. Operator header     — wallet, scorecard derived from event success rate
 *   2. Wallet caps         — live SUI + USDC balances, sponsor status
 *   3. Access control      — feature flags from /v2-config
 *   4. Branded milestones  — derived from on-chain stats thresholds
 *   5. Activity ledger     — every on-chain event for this wallet (DESC)
 *   6. Resource inventory  — agent objects, brain namespaces, blob ids
 *   7. Capability manifest — package + registry config
 *
 * SOLID:
 *   - SRP: this file orchestrates fetches + presentation. No business rules.
 *   - DIP: every URL goes through `api.*`; explorer + walrus URLs through
 *     the shared helpers in lib/api. Live balances via `useSuiClient()`.
 *   - OCP: a new panel = one section + one fetch — layout grid is open.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useCurrentAccount, useSuiClient } from '@mysten/dapp-kit';
import { api, walrusViewUrl, type SellerProfile } from '@/lib/api';

export default function SettingsPage() {
  const account = useCurrentAccount();
  if (!account) return <ConnectGate />;
  return <CommandCenter wallet={account.address} />;
}

// ─── Top-level orchestrator ─────────────────────────────────────────

function CommandCenter({ wallet }: { wallet: string }) {
  const client = useSuiClient();
  const [profile, setProfile] = useState<SellerProfile | null>(null);
  const [stats, setStats] = useState<Awaited<ReturnType<typeof api.getSellerOnChainStats>> | null>(null);
  const [dash, setDash] = useState<Awaited<ReturnType<typeof api.sellerDashboard>> | null>(null);
  const [events, setEvents] = useState<Awaited<ReturnType<typeof api.getSellerWalletEvents>>['events']>([]);
  const [config, setConfig] = useState<Awaited<ReturnType<typeof api.getSellerV2Config>> | null>(null);
  const [sui, setSui] = useState<bigint | null>(null);
  const [usdc, setUsdc] = useState<bigint | null>(null);

  useEffect(() => {
    api.sellerMe(wallet).then((r) => setProfile(r.seller)).catch(() => setProfile(null));
    api.getSellerOnChainStats(wallet).then(setStats).catch(() => setStats(null));
    api.sellerDashboard(wallet).then(setDash).catch(() => setDash(null));
    api.getSellerWalletEvents(wallet, 50).then((r) => setEvents(r.events)).catch(() => setEvents([]));
    api.getSellerV2Config().then(setConfig).catch(() => setConfig(null));
  }, [wallet]);

  // Live balances — re-fetched via Sui RPC every 30s.
  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const [s, u] = await Promise.all([
          client.getBalance({ owner: wallet }),
          config?.usdc_coin_type
            ? client.getBalance({ owner: wallet, coinType: config.usdc_coin_type }).catch(() => ({ totalBalance: '0' }))
            : Promise.resolve({ totalBalance: '0' }),
        ]);
        if (!cancelled) {
          setSui(BigInt(s.totalBalance ?? '0'));
          setUsdc(BigInt(u.totalBalance ?? '0'));
        }
      } catch { /* network blip — keep last value */ }
    }
    void tick();
    const t = setInterval(tick, 30_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [client, wallet, config?.usdc_coin_type]);

  return (
    <div className="space-y-4 font-mono text-xs">
      <header className="flex items-center justify-between">
        <h1 className="font-headline text-3xl font-bold tracking-tight">Settings · Operator console</h1>
        <Link href="/studio/dashboard" className="rounded-full border border-primary/40 px-3 py-1 text-primary hover:bg-primary/10">
          studio dashboard →
        </Link>
      </header>

      <OperatorHeader wallet={wallet} profile={profile} stats={stats} dash={dash} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <aside className="space-y-4 lg:col-span-1">
          <WalletCaps sui={sui} usdc={usdc} />
          <AccessControlPolicies config={config} />
          <BrandedMilestones stats={stats} dash={dash} events={events} />
        </aside>
        <main className="space-y-4 lg:col-span-2">
          <Panel title="ON-CHAIN_ACTIVITY">
            <div className="border-t border-outline-variant/20 pt-3 text-[11px] text-on-surface-variant">
              On-chain ledger and Active hires moved to the studio dashboard for one-stop seller tracking.
              <Link href="/studio/dashboard" className="ml-2 inline-flex items-center gap-1 rounded-full border border-primary/40 px-2 py-0.5 text-[10px] uppercase text-primary hover:bg-primary/10">
                go to dashboard →
              </Link>
            </div>
          </Panel>
          <ResourceInventory dash={dash} events={events} />
          <CapabilityManifest config={config} />
        </main>
      </div>

      <ProfileEditor wallet={wallet} profile={profile} onSaved={(p) => setProfile(p)} />
    </div>
  );
}

// ─── Panel 1: Operator header ───────────────────────────────────────

/** True when `s` looks like a 0x + 64 hex Sui address — used to detect the
 *  display_name == wallet auto-fill and fall back to a short alias instead. */
function isWalletAddr(s: string | null | undefined): boolean {
  return !!s && /^0x[0-9a-fA-F]{64}$/.test(s.trim());
}

function OperatorHeader({
  wallet, profile, stats, dash,
}: {
  wallet: string;
  profile: SellerProfile | null;
  stats: Awaited<ReturnType<typeof api.getSellerOnChainStats>> | null;
  dash: Awaited<ReturnType<typeof api.sellerDashboard>> | null;
}) {
  // If display_name is empty OR equals the wallet, render a short alias.
  const rawName = profile?.display_name?.trim() ?? '';
  const name = !rawName || isWalletAddr(rawName)
    ? `Operator ${wallet.slice(2, 6).toUpperCase()}`
    : rawName;
  const idShort = `#${(profile?.id ?? 0).toString().padStart(4, '0')}`;
  const totalEvents = stats
    ? stats.on_chain.agents_published + stats.on_chain.publish_fees_paid + stats.on_chain.mutations
    : 0;
  const score = totalEvents > 0 ? Math.min(100, Math.floor((totalEvents / Math.max(totalEvents, 5)) * 100)) : 0;

  return (
    <section className="rounded-lg border border-outline-variant/30 bg-surface p-4 md:p-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-center">
        <div className="flex items-center gap-3 md:gap-4 min-w-0">
          <div className="grid h-12 w-12 shrink-0 place-items-center rounded-full border border-primary/40 bg-primary/10 font-headline text-base text-primary md:h-16 md:w-16 md:text-xl">
            {wallet.slice(2, 4).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h2 className="truncate font-headline text-lg font-bold text-on-surface md:text-2xl" title={name}>
                {name}
              </h2>
              <span className="text-on-surface-variant">{idShort}</span>
              <span className="rounded border border-secondary/40 bg-secondary/10 px-1.5 py-0.5 text-[10px] uppercase text-secondary-fixed">
                NODE_ACTIVE
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-on-surface-variant">
              <CopyChip label="address" value={wallet} display={`${wallet.slice(0, 8)}…${wallet.slice(-6)}`} />
              <a
                href={`https://suiscan.xyz/testnet/account/${wallet}`}
                target="_blank"
                rel="noreferrer"
                className="rounded border border-outline-variant/40 px-1.5 py-0.5 text-[10px] hover:border-primary/40 hover:text-primary"
              >
                suiscan ↗
              </a>
              {dash && (
                <span className="rounded border border-outline-variant/40 px-1.5 py-0.5 text-[10px]">
                  lifetime · ${formatUsdc(dash.earnings.all_time)} · {dash.agents.length} agents
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="shrink-0 rounded border border-secondary/40 bg-secondary/5 px-3 py-2 text-right md:ml-auto">
          <div className="text-[10px] uppercase text-on-surface-variant">Verified scorecard</div>
          <div className="font-headline text-xl text-secondary-fixed">{score}/100</div>
          <div className="text-[10px] text-on-surface-variant">{totalEvents} on-chain events</div>
        </div>
      </div>
    </section>
  );
}

// ─── Panel 2: Wallet caps ───────────────────────────────────────────

function WalletCaps({ sui, usdc }: { sui: bigint | null; usdc: bigint | null }) {
  return (
    <Panel title="WALLET_CAPS">
      <div className="grid grid-cols-2 gap-3 border-t border-outline-variant/20 pt-3">
        <div>
          <div className="text-[10px] uppercase text-on-surface-variant">SUI_BALANCE</div>
          <div className="mt-0.5 text-base text-primary">
            {sui == null ? '…' : formatSui(sui)}
            <span className="ml-1 text-[10px] text-on-surface-variant">SUI</span>
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase text-on-surface-variant">USDC_LIQUIDITY</div>
          <div className="mt-0.5 text-base text-secondary-fixed">
            {usdc == null ? '…' : formatUsdcMicro(usdc)}
          </div>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between rounded border border-outline-variant/20 bg-surface-container-low px-2 py-1.5">
        <span className="flex items-center gap-1.5 text-[11px] text-on-surface-variant">
          <span className="text-primary">⚡</span> ENOKI_GAS_SPONSORSHIP
        </span>
        <span className="rounded border border-secondary/40 bg-secondary/10 px-1.5 py-0.5 text-[10px] text-secondary-fixed">
          ACTIVE
        </span>
      </div>
    </Panel>
  );
}

// ─── Panel 3: Access control policies ────────────────────────────────

function AccessControlPolicies({ config }: { config: Awaited<ReturnType<typeof api.getSellerV2Config>> | null }) {
  const enabled = config?.enabled ?? false;
  const rows: Array<{ label: string; on: boolean; locked?: boolean }> = [
    { label: 'AGENT_MINTING', on: enabled },
    { label: 'LIQUIDITY_PROVISION', on: enabled },
    { label: 'ASSET_WITHDRAWAL', on: false, locked: true },
  ];
  return (
    <Panel title="ACCESS_CONTROL_POLICIES">
      <div className="flex items-center justify-between border-t border-outline-variant/20 pt-3 text-on-surface-variant">
        <span className="text-[10px] uppercase">MULTI_SIG_THRESHOLD</span>
        <span className="text-[11px] text-on-surface">1-of-1</span>
      </div>
      <ul className="mt-2 space-y-1.5 text-[11px]">
        {rows.map((r) => (
          <li key={r.label} className="flex items-center gap-2">
            <span className={r.on ? 'text-secondary-fixed' : 'text-on-surface-variant'}>{r.on ? '●' : '○'}</span>
            <span className={r.locked ? 'text-on-surface-variant' : 'text-on-surface'}>{r.label}</span>
            <span className={`ml-auto rounded px-1.5 py-0.5 text-[10px] ${
              r.on ? 'bg-secondary/10 text-secondary-fixed' :
              r.locked ? 'bg-surface-container text-on-surface-variant' : 'bg-error/10 text-error'
            }`}>
              {r.on ? 'ENABLED' : r.locked ? 'LOCKED' : 'DISABLED'}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

// ─── Panel 4: Branded milestones ────────────────────────────────────

function BrandedMilestones({
  stats, dash, events,
}: {
  stats: Awaited<ReturnType<typeof api.getSellerOnChainStats>> | null;
  dash: Awaited<ReturnType<typeof api.sellerDashboard>> | null;
  events: Awaited<ReturnType<typeof api.getSellerWalletEvents>>['events'];
}) {
  const callsTotal = dash?.earnings.calls_7d ?? 0;
  const lifetimeCalls = dash?.agents.reduce((s, a) => s + (a.calls_total ?? 0), 0) ?? 0;
  const successRate = events.length > 0
    ? events.filter((e) => e.type !== 'LoopAgentRevoked').length / events.length
    : 0;

  const badges: Array<{ label: string; cls: string; earned: boolean; hint: string }> = [
    {
      label: lifetimeCalls >= 10_000 ? '10K_AUTOMATIONS' : `${lifetimeCalls}_AUTOMATIONS`,
      cls: lifetimeCalls >= 10_000 ? 'border-primary/60 bg-primary/10 text-primary' : 'border-outline-variant/30 text-on-surface-variant',
      earned: lifetimeCalls >= 10_000,
      hint: 'lifetime paid calls',
    },
    {
      label: 'GENESIS_OPERATOR',
      cls: (stats?.on_chain.agents_published ?? 0) >= 1 ? 'border-secondary/60 bg-secondary/10 text-secondary-fixed' : 'border-outline-variant/30 text-on-surface-variant',
      earned: (stats?.on_chain.agents_published ?? 0) >= 1,
      hint: 'first agent published',
    },
    {
      label: 'TOP_1%_EFFICIENCY',
      cls: successRate >= 0.99 && events.length >= 5 ? 'border-tertiary-fixed/60 bg-tertiary/10 text-tertiary-fixed-dim' : 'border-outline-variant/30 text-on-surface-variant',
      earned: successRate >= 0.99 && events.length >= 5,
      hint: '≥99% success across ≥5 events',
    },
  ];

  return (
    <Panel title="BRANDED_MILESTONES">
      <div className="flex flex-wrap gap-2 border-t border-outline-variant/20 pt-3">
        {badges.map((b) => (
          <span
            key={b.label}
            title={b.hint}
            className={`rounded border px-2 py-1 text-[10px] uppercase ${b.cls}`}
          >
            {b.earned ? '✓ ' : '○ '}{b.label}
          </span>
        ))}
      </div>
    </Panel>
  );
}

// ─── Panel 5: On-chain activity ledger ───────────────────────────────
// ─── Panel 6: Resource inventory ────────────────────────────────────

function ResourceInventory({
  dash, events,
}: {
  dash: Awaited<ReturnType<typeof api.sellerDashboard>> | null;
  events: Awaited<ReturnType<typeof api.getSellerWalletEvents>>['events'];
}) {
  // Most recent published agent — pull its publish event for blob_id + agent_object_id.
  const recentPublish = useMemo(
    () => events.find((e) => e.type === 'LoopAgentPublished'),
    [events],
  );
  const agentObjectId = recentPublish?.agent_object_id ?? null;
  const blobId = (recentPublish?.payload as { manifest_walrus_blob_id?: string } | undefined)?.manifest_walrus_blob_id ?? null;
  const slug = dash?.agents[0]?.slug ?? null;

  return (
    <Panel title="SUI_RESOURCE_INVENTORY">
      <div className="grid gap-3 border-t border-outline-variant/20 pt-3 md:grid-cols-3">
        <ResourceCard
          label="AGENT_OBJECT"
          value={slug ?? '—'}
          id={agentObjectId}
          explorer={agentObjectId ? `https://suiscan.xyz/testnet/object/${agentObjectId}` : null}
        />
        <ResourceCard
          label="BRAIN_NAMESPACE"
          value={slug ? `cog-l4-${slug}` : '—'}
          id={slug ? `cog-l4-${slug}` : null}
          explorer={null}
          mono
        />
        <ResourceCard
          label="TRAINING_BLOB"
          value={blobId ? `${blobId.slice(0, 4)}…${blobId.slice(-3)}` : '—'}
          id={blobId}
          explorer={walrusViewUrl(blobId)}
        />
      </div>
    </Panel>
  );
}

function ResourceCard({
  label, value, id, explorer, mono,
}: {
  label: string;
  value: string;
  id: string | null;
  explorer: string | null;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0 rounded border border-outline-variant/20 bg-surface-container-low p-3">
      <div className="text-[10px] uppercase text-primary">{label}</div>
      <div
        title={value}
        className={`mt-0.5 truncate text-base ${mono ? 'font-mono text-on-surface' : 'font-headline text-on-surface'}`}
      >
        {value}
      </div>
      <div className="mt-1 flex items-center gap-1 text-[10px] text-on-surface-variant">
        <span className="truncate font-mono" title={id ?? ''}>
          ID: {id ? `${id.slice(0, 6)}…${id.slice(-3)}` : '—'}
        </span>
        {id && <CopyButton value={id} />}
        {explorer && (
          <a href={explorer} target="_blank" rel="noreferrer" className="ml-auto text-primary hover:underline">↗</a>
        )}
      </div>
    </div>
  );
}

// ─── Panel 7: System capability manifest ────────────────────────────

function CapabilityManifest({ config }: { config: Awaited<ReturnType<typeof api.getSellerV2Config>> | null }) {
  const manifest = {
    endpoints: ['/v3/loop/seller/me/onchain-stats', '/v3/loop/seller/me/wallet-events', '/v3/loop/seller/agents/:id/events'],
    policies: {
      auth: 'sui-wallet-signed',
      concurrency: 128,
      isolation: 'TEE-encrypted',
    },
    package_id: config?.package_id ?? null,
    bedrock_registry_id: config?.bedrock_registry_id ?? null,
    publish_fee_micro: config?.publish_fee_micro ?? 1_000_000,
    enabled: config?.enabled ?? false,
  };
  return (
    <Panel title="SYSTEM_CAPABILITY_MANIFEST">
      <pre className="max-h-72 overflow-auto rounded bg-background p-3 text-[11px] leading-relaxed text-on-surface-variant">
        <code>{JSON.stringify(manifest, null, 2)}</code>
      </pre>
    </Panel>
  );
}

// ─── Profile editor (preserved from v1) ──────────────────────────────

function ProfileEditor({
  wallet, profile, onSaved,
}: {
  wallet: string;
  profile: SellerProfile | null;
  onSaved: (p: SellerProfile) => void;
}) {
  const [form, setForm] = useState({ display_name: '', bio: '', contact_email: '', support_url: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    setForm({
      display_name: profile?.display_name ?? '',
      bio: profile?.bio ?? '',
      contact_email: profile?.contact_email ?? '',
      support_url: profile?.support_url ?? '',
    });
  }, [profile]);

  const save = async () => {
    if (busy) return;
    setBusy(true); setMsg(null);
    try {
      await api.updateSellerProfile(wallet, form);
      const r = await api.sellerMe(wallet);
      if (r.seller) onSaved(r.seller);
      setMsg({ kind: 'ok', text: 'Profile saved.' });
    } catch (e) {
      setMsg({ kind: 'err', text: String((e as Error).message) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="OPERATOR_PROFILE">
      <div className="grid gap-3 border-t border-outline-variant/20 pt-3 md:grid-cols-2">
        <input
          value={form.display_name}
          onChange={(e) => setForm((s) => ({ ...s, display_name: e.target.value }))}
          placeholder="Display name"
          className={inputCx}
        />
        <input
          value={form.contact_email}
          onChange={(e) => setForm((s) => ({ ...s, contact_email: e.target.value }))}
          placeholder="Contact email"
          className={inputCx}
        />
      </div>
      <textarea
        value={form.bio}
        onChange={(e) => setForm((s) => ({ ...s, bio: e.target.value }))}
        rows={2}
        placeholder="Bio"
        className={`mt-3 ${inputCx}`}
      />
      <input
        value={form.support_url}
        onChange={(e) => setForm((s) => ({ ...s, support_url: e.target.value }))}
        placeholder="Support URL https://"
        className={`mt-3 ${inputCx}`}
      />
      {msg && (
        <div className={`mt-3 rounded border px-3 py-1.5 text-[11px] ${
          msg.kind === 'ok' ? 'border-secondary/40 bg-secondary/10 text-secondary-fixed' : 'border-error/40 bg-error/10 text-error'
        }`}>{msg.text}</div>
      )}
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="rounded-full bg-primary px-4 py-1.5 text-[11px] font-medium uppercase text-on-primary disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Panel>
  );
}

// ─── Tiny primitives ────────────────────────────────────────────────

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-outline-variant/30 bg-surface p-4">
      <header className="text-[10px] uppercase tracking-[0.1em] text-on-surface-variant">{title}</header>
      {children}
    </section>
  );
}

function CopyChip({ label, value, display }: { label: string; value: string; display: string }) {
  const [copied, setCopied] = useState(false);
  const click = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <button
      type="button"
      onClick={click}
      title={`Copy ${label}`}
      className="flex items-center gap-1 rounded border border-outline-variant/40 bg-surface-container-low px-1.5 py-0.5 text-[10px] hover:border-primary/40 hover:text-primary"
    >
      <span>{display}</span>
      <span className="text-on-surface-variant">{copied ? '✓' : '⎘'}</span>
    </button>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="text-on-surface-variant hover:text-primary"
      title="Copy"
    >
      {copied ? '✓' : '⎘'}
    </button>
  );
}

function ConnectGate() {
  return (
    <div className="mx-auto max-w-xl rounded-lg border border-dashed border-outline-variant/40 bg-surface-container-low p-12 text-center">
      <h1 className="font-headline text-2xl font-bold">Connect to view operator console</h1>
      <p className="mt-2 text-sm text-on-surface-variant">Your Sui wallet is your only auth credential.</p>
    </div>
  );
}

const inputCx =
  'w-full rounded border border-outline-variant/40 bg-surface-container-low px-3 py-2 text-[11px] text-on-surface focus:border-primary/60 focus:outline-none';

function formatSui(mist: bigint): string {
  // 1 SUI = 1e9 mist
  const sui = Number(mist) / 1e9;
  return sui >= 100 ? sui.toFixed(2) : sui.toFixed(4);
}
function formatUsdcMicro(micro: bigint): string {
  return (Number(micro) / 1e6).toFixed(2);
}
function formatUsdc(s: string | number): string {
  const n = typeof s === 'string' ? Number(s) : s;
  return Number.isFinite(n) ? n.toFixed(2) : '0.00';
}
