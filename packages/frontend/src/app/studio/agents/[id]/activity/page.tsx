'use client';

/**
 * /studio/agents/[id]/activity — seller-side on-chain event timeline.
 *
 * Renders every Move event emitted by `openx_loop_agent_registry` for a
 * given agent, sorted DESC by timestamp. Sellers can issue 3 mutation PTBs
 * inline (Edit pricing / Change model / Revoke). Each event card links to
 * Suiscan via the shared `explorerTxUrl()` helper.
 *
 * SOLID:
 *   - SRP: presentation. Fetch via `api.*`; sign via `useSignAndExecuteTransaction`.
 *   - DIP: shared explorer/walrus helpers; never hard-codes URLs.
 *   - OCP: a new event type = one line in EVENT_META.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCurrentAccount, useSignAndExecuteTransaction } from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import { api, explorerTxUrl } from '@/lib/api';
import { BEDROCK_MODEL_CATALOG } from '@fhe-ai-context/sui-sdk';

const NETWORK = process.env.NEXT_PUBLIC_SUI_NETWORK ?? 'sui-testnet';

interface AgentEvent {
  type: string;
  tx_digest: string;
  seq_in_tx: number;
  payload: Record<string, unknown>;
  timestamp_ms: number;
}

const EVENT_META: Record<string, { icon: string; label: string; cls: string }> = {
  LoopAgentPublished:    { icon: '✓', label: 'Published',           cls: 'bg-emerald-500/15 text-emerald-300' },
  AgentPublishFeePaid:   { icon: '💰', label: 'Publish fee paid',   cls: 'bg-amber-500/15 text-amber-300' },
  AgentPricingUpdated:   { icon: '💲', label: 'Pricing updated',    cls: 'bg-primary/15 text-primary' },
  AgentModelUpdated:     { icon: '🤖', label: 'Model updated',      cls: 'bg-primary/15 text-primary' },
  AgentManifestUpdated:  { icon: '📝', label: 'Manifest updated',   cls: 'bg-primary/15 text-primary' },
  AgentManifestAttested: { icon: '🔏', label: 'Manifest attested',  cls: 'bg-purple-500/15 text-purple-300' },
  LoopAgentRevoked:      { icon: '⚠', label: 'Revoked',             cls: 'bg-error/15 text-error' },
  LoopAgentReputationUpdated: { icon: '⭐', label: 'Reputation', cls: 'bg-surface-container text-on-surface-variant' },
};

export default function ActivityPage() {
  const params = useParams<{ id: string }>();
  const slug = params.id;
  const account = useCurrentAccount();

  if (!account?.address) {
    return (
      <div className="mx-auto max-w-md rounded-xl border border-dashed border-outline-variant/40 bg-surface-container-low p-12 text-center">
        <h1 className="font-headline text-2xl font-bold">Connect to view activity</h1>
        <p className="mt-2 text-sm text-on-surface-variant">Only the agent owner can perform mutations.</p>
      </div>
    );
  }
  return <ActivityDashboard wallet={account.address} slug={slug} />;
}

function ActivityDashboard({ wallet, slug }: { wallet: string; slug: string }) {
  const [data, setData] = useState<{ agent_object_id: string | null; events: AgentEvent[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openModal, setOpenModal] = useState<'pricing' | 'model' | 'manifest' | 'revoke' | null>(null);

  const reload = () => {
    api.getSellerAgentEvents(wallet, slug)
      .then((r) => setData(r))
      .catch((e) => setError((e as Error).message));
  };

  useEffect(() => { reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [wallet, slug]);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <Link href="/studio" className="font-mono text-xs text-on-surface-variant hover:text-primary">
          ← Studio
        </Link>
        <h1 className="mt-2 font-headline text-3xl font-bold">Agent activity</h1>
        <p className="text-on-surface-variant">
          On-chain history for <code className="font-mono text-on-surface">{slug}</code>.
          Every action is a Sui Move event — verifiable on Suiscan.
        </p>
      </header>

      <section className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setOpenModal('pricing')}
          className="rounded-full border border-primary/40 px-3 py-1 font-mono text-xs text-primary hover:bg-primary/10"
        >
          💲 Edit pricing
        </button>
        <button
          type="button"
          onClick={() => setOpenModal('model')}
          className="rounded-full border border-primary/40 px-3 py-1 font-mono text-xs text-primary hover:bg-primary/10"
        >
          🤖 Change model
        </button>
        <button
          type="button"
          onClick={() => setOpenModal('manifest')}
          className="rounded-full border border-primary/40 px-3 py-1 font-mono text-xs text-primary hover:bg-primary/10"
        >
          📝 Update manifest
        </button>
        <button
          type="button"
          onClick={() => setOpenModal('revoke')}
          className="rounded-full border border-error/40 px-3 py-1 font-mono text-xs text-error hover:bg-error/10"
        >
          ⚠ Revoke
        </button>
        {data?.agent_object_id && (
          <a
            href={`https://suiscan.xyz/testnet/object/${data.agent_object_id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto rounded-full border border-outline-variant/40 px-3 py-1 font-mono text-[10px] text-on-surface-variant hover:bg-surface-container"
          >
            view Agent on Suiscan ↗
          </a>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="font-headline text-lg font-bold">Timeline</h2>
        {error && <div className="rounded-md border border-error/40 bg-error/10 p-2 text-xs text-error">{error}</div>}
        {!data && <div className="text-sm text-on-surface-variant">Loading…</div>}
        {data && data.events.length === 0 && (
          <div className="rounded-lg border border-dashed border-outline-variant/30 bg-surface-container-low p-6 text-center text-sm text-on-surface-variant">
            No on-chain events yet. After your next signed action this list updates within ~60s (indexer cadence).
          </div>
        )}
        {data && data.events.length > 0 && (
          <ul className="space-y-2">
            {data.events.map((e) => <EventCard key={`${e.tx_digest}-${e.seq_in_tx}`} event={e} />)}
          </ul>
        )}
      </section>

      {openModal && (
        <MutationModal
          kind={openModal}
          slug={slug}
          wallet={wallet}
          agentObjectId={data?.agent_object_id ?? undefined}
          onClose={() => { setOpenModal(null); setTimeout(reload, 1500); }}
        />
      )}
    </div>
  );
}

function EventCard({ event }: { event: AgentEvent }) {
  const meta = EVENT_META[event.type] ?? { icon: '•', label: event.type, cls: 'bg-surface-container text-on-surface-variant' };
  const explorer = explorerTxUrl(NETWORK, event.tx_digest);
  return (
    <li className="rounded-lg border border-outline-variant/20 bg-surface-container-low p-3">
      <header className="flex items-center gap-2 text-xs">
        <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${meta.cls}`}>{meta.icon} {meta.label}</span>
        <span className="font-mono text-[10px] text-on-surface-variant">
          {new Date(event.timestamp_ms).toLocaleString()}
        </span>
        {explorer && (
          <a
            href={explorer}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto font-mono text-[10px] text-primary hover:underline"
          >
            tx {event.tx_digest.slice(0, 8)}… ↗
          </a>
        )}
      </header>
      <PayloadDiff type={event.type} payload={event.payload} />
    </li>
  );
}

function PayloadDiff({ type, payload }: { type: string; payload: Record<string, unknown> }) {
  switch (type) {
    case 'AgentPricingUpdated':
      return (
        <p className="mt-1 font-mono text-[11px] text-on-surface-variant">
          {fmtMicroUsdc(payload.old_per_iter_default)} → {fmtMicroUsdc(payload.new_per_iter_default)} ·
          max iter {String(payload.old_max_iter)} → {String(payload.new_max_iter)}
        </p>
      );
    case 'AgentModelUpdated':
      return (
        <p className="mt-1 font-mono text-[11px] text-on-surface-variant">
          <code>{String(payload.old_model_id)}</code> → <code>{String(payload.new_model_id)}</code>
        </p>
      );
    case 'AgentManifestUpdated':
      return (
        <p className="mt-1 font-mono text-[11px] text-on-surface-variant">
          blob <code>{String(payload.old_walrus_blob_id).slice(0, 16)}…</code> → <code>{String(payload.new_walrus_blob_id).slice(0, 16)}…</code>
        </p>
      );
    case 'AgentPublishFeePaid':
      return (
        <p className="mt-1 font-mono text-[11px] text-on-surface-variant">
          paid {fmtMicroUsdc(payload.fee_micro)} USDC to admin <code>{String(payload.admin_addr).slice(0, 10)}…</code>
        </p>
      );
    default:
      return null;
  }
}

function MutationModal({
  kind, slug, wallet, agentObjectId, onClose,
}: {
  kind: 'pricing' | 'model' | 'manifest' | 'revoke';
  slug: string;
  wallet: string;
  agentObjectId?: string;
  onClose: () => void;
}) {
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state per kind
  const [perIterMin, setPerIterMin] = useState('10000');
  const [perIterDefault, setPerIterDefault] = useState('50000');
  const [maxIter, setMaxIter] = useState('10');
  const [newModelId, setNewModelId] = useState(BEDROCK_MODEL_CATALOG[3]?.id ?? '');
  const [newBlob, setNewBlob] = useState('');
  const [sha256Hex, setSha256Hex] = useState('');

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      let resp: { ptb_bytes_b64: string };
      if (kind === 'pricing') {
        resp = await api.buildUpdatePricing(wallet, slug, {
          sui_object_id: agentObjectId,
          per_iter_min_micro_usdc: Number(perIterMin),
          per_iter_default_micro_usdc: Number(perIterDefault),
          max_iter_per_job: Number(maxIter),
        });
      } else if (kind === 'model') {
        resp = await api.buildUpdateModel(wallet, slug, {
          sui_object_id: agentObjectId,
          new_model_id: newModelId,
        });
      } else if (kind === 'manifest') {
        resp = await api.buildUpdateManifest(wallet, slug, {
          sui_object_id: agentObjectId,
          new_walrus_blob_id: newBlob,
          manifest_sha256_b64: hexToBase64(sha256Hex),
        });
      } else {
        resp = await api.buildRevokeAgent(wallet, slug, { sui_object_id: agentObjectId });
      }
      const tx = Transaction.from(Buffer.from(resp.ptb_bytes_b64, 'base64'));
      await signAndExecute({ transaction: tx as unknown as Parameters<typeof signAndExecute>[0]['transaction'] });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md space-y-3 rounded-xl border border-outline-variant/40 bg-surface p-5">
        <header className="flex items-center justify-between">
          <h3 className="font-headline text-lg font-bold">
            {kind === 'pricing' && '💲 Edit pricing'}
            {kind === 'model' && '🤖 Change model'}
            {kind === 'manifest' && '📝 Update manifest'}
            {kind === 'revoke' && '⚠ Revoke agent'}
          </h3>
          <button onClick={onClose} className="rounded-full border border-outline-variant/30 px-2 py-0.5 font-mono text-xs text-on-surface-variant">
            ✕
          </button>
        </header>

        {kind === 'pricing' && (
          <>
            <Field label="Per-iter min (µUSDC)"><input className={inputCx} value={perIterMin} onChange={(e) => setPerIterMin(e.target.value)} /></Field>
            <Field label="Per-iter default (µUSDC)"><input className={inputCx} value={perIterDefault} onChange={(e) => setPerIterDefault(e.target.value)} /></Field>
            <Field label="Max iter per job"><input className={inputCx} value={maxIter} onChange={(e) => setMaxIter(e.target.value)} /></Field>
          </>
        )}
        {kind === 'model' && (
          <Field label="New Bedrock model">
            <select className={inputCx} value={newModelId} onChange={(e) => setNewModelId(e.target.value)}>
              {BEDROCK_MODEL_CATALOG.map((m) => (
                <option key={m.id} value={m.id}>{m.label} ({m.tier})</option>
              ))}
            </select>
          </Field>
        )}
        {kind === 'manifest' && (
          <>
            <Field label="New Walrus blob id"><input className={inputCx} value={newBlob} onChange={(e) => setNewBlob(e.target.value)} /></Field>
            <Field label="Manifest SHA-256 (hex)"><input className={inputCx} placeholder="64 hex chars" value={sha256Hex} onChange={(e) => setSha256Hex(e.target.value)} /></Field>
          </>
        )}
        {kind === 'revoke' && (
          <p className="rounded-md border border-error/30 bg-error/10 p-3 text-xs text-error">
            Revoking is permanent — buyers will no longer be able to hire or call the agent. The seller object stays on-chain for verifiability.
          </p>
        )}

        {error && <div className="rounded-md border border-error/40 bg-error/10 p-2 text-xs text-error">{error}</div>}

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-full border border-outline-variant/30 px-3 py-1 font-mono text-xs">Cancel</button>
          <button
            onClick={submit}
            disabled={busy}
            className={`rounded-full px-3 py-1 font-mono text-xs text-on-primary disabled:opacity-50 ${kind === 'revoke' ? 'bg-error' : 'bg-primary'}`}
          >
            {busy ? 'Signing…' : 'Sign + execute'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="font-mono text-[10px] uppercase text-on-surface-variant">{label}</span>
      {children}
    </label>
  );
}

const inputCx = 'w-full rounded-md border border-outline-variant/30 bg-surface-container-low px-3 py-2 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-primary';

function fmtMicroUsdc(v: unknown): string {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : 0;
  return `$${(n / 1_000_000).toFixed(4)} USDC`;
}

function hexToBase64(hex: string): string {
  const clean = hex.trim().replace(/^0x/, '');
  if (!clean) return Buffer.from(new Uint8Array(32)).toString('base64');
  if (!/^[0-9a-fA-F]+$/.test(clean)) return Buffer.from(new Uint8Array(32)).toString('base64');
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  return Buffer.from(bytes).toString('base64');
}
