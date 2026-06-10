'use client';

import { useEffect, useState } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit';
import { api } from '@/lib/api';

/**
 * /train — write knowledge into the caller-owned MemWal account.
 *
 *   POST /v3/memory/remember
 *     body: { text, namespace? }
 *     500-byte text becomes one Walrus blob; longer text is auto-chunked.
 *
 * SOLID:
 *  - SRP: this file owns the write-and-render-receipt loop. No business
 *    logic — `lib/api` owns the wire.
 *  - DIP: depends on `api.memwalRemember(...)` and `api.memwalAccount(...)`.
 *  - OCP: a new MemWal verb (analyze, restore) = one button + one helper.
 */

interface Remembered {
  id: number;
  text: string;
  namespace: string;
  blob_id: string | null;
  mode?: string;
  ts: number;
}

export default function TrainPage() {
  const account = useCurrentAccount();
  if (!account) return <ConnectGate />;
  return <Train wallet={account.address} />;
}

function Train({ wallet }: { wallet: string }) {
  const [text, setText] = useState('');
  const [namespace, setNamespace] = useState('cog-l3-default');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [history, setHistory] = useState<Remembered[]>([]);
  const [accountId, setAccountId] = useState<string | null>(null);

  // One-shot account resolve. If null → MemWal account isn't provisioned;
  // /v3/memory/remember will return 409 unless the API has
  // MEMWAL_FALLBACK_MODE=mock set (which dev-mode does).
  useEffect(() => {
    api.memwalAccount(wallet)
      .then((r) => setAccountId(r.accountId))
      .catch(() => setAccountId(null));
  }, [wallet]);

  async function remember() {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.memwalRemember(wallet, body, namespace.trim() || undefined);
      setHistory((h) => [
        { id: Date.now(), text: body, namespace, blob_id: r.blob_id, mode: r.mode, ts: Date.now() },
        ...h,
      ]);
      setText('');
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  const charCount = text.length;
  const valid = text.trim().length >= 4 && namespace.trim().length > 0;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="font-headline text-3xl font-bold">Train</h1>
        <p className="text-on-surface-variant">
          Write encrypted knowledge into your MemWal account. Each entry becomes a Walrus blob your agents can recall.
        </p>
      </header>

      <ProvisionBanner accountId={accountId} />

      <div className="space-y-4 rounded-xl border border-outline-variant/30 bg-surface p-6">
        <div className="grid gap-3 sm:grid-cols-[1fr,200px]">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-on-surface">Knowledge</span>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={6}
              maxLength={4000}
              placeholder="Type or paste any text. Markdown is fine. The brain is yours; OpenX never sees plaintext."
              className="w-full rounded-lg border border-outline-variant/40 bg-surface-container-low px-3 py-2 text-sm focus:border-primary/60 focus:outline-none"
            />
            <span className="font-mono text-[10px] text-on-surface-variant">{charCount} / 4000</span>
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-on-surface">Namespace</span>
            <input
              value={namespace}
              onChange={(e) => setNamespace(e.target.value)}
              className="w-full rounded-lg border border-outline-variant/40 bg-surface-container-low px-3 py-2 font-mono text-xs focus:border-primary/60 focus:outline-none"
              placeholder="cog-l3-default"
            />
            <span className="font-mono text-[10px] text-on-surface-variant">
              cog-l{`{1..5}`}-{`{brain}`}
            </span>
          </label>
        </div>

        {err && (
          <div className="rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
            {err}
          </div>
        )}

        <div className="flex items-center justify-between gap-3 border-t border-outline-variant/20 pt-3">
          <span className="font-mono text-[11px] text-on-surface-variant">
            Wallet · {wallet.slice(0, 6)}…{wallet.slice(-4)}
          </span>
          <button
            type="button"
            disabled={!valid || busy}
            onClick={remember}
            className="rounded-full bg-primary px-5 py-2 text-sm font-medium text-on-primary disabled:opacity-50"
          >
            {busy ? 'Writing…' : 'Remember'}
          </button>
        </div>
      </div>

      {history.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-headline text-base font-semibold">Recent writes</h2>
          <ul className="space-y-2">
            {history.map((h) => (
              <li key={h.id} className="rounded-lg border border-outline-variant/30 bg-surface-container-low p-3">
                <div className="flex items-center justify-between gap-2 font-mono text-[10px] text-on-surface-variant">
                  <span>{h.namespace}</span>
                  <span>{h.blob_id ?? '—'}{h.mode ? ` · ${h.mode}` : ''}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-on-surface">{h.text}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ProvisionBanner({ accountId }: { accountId: string | null }) {
  if (accountId) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-secondary/30 bg-secondary/5 px-4 py-3 text-sm">
        <span className="material-symbols-outlined text-secondary">check_circle</span>
        <span className="text-on-surface-variant">
          MemWal account ready · <code className="font-mono text-on-surface">{accountId.slice(0, 10)}…{accountId.slice(-6)}</code>
        </span>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-tertiary/30 bg-tertiary/5 px-4 py-3 text-sm">
      <div className="flex items-start gap-2">
        <span className="material-symbols-outlined text-tertiary">info</span>
        <div className="space-y-1">
          <div className="font-medium text-on-surface">No MemWal account provisioned yet</div>
          <p className="text-xs text-on-surface-variant">
            On dev/staging the API runs <code className="font-mono">MEMWAL_FALLBACK_MODE=mock</code> so writes succeed
            with a synthesized local blob id. On production, provision a MemWalAccount once via{' '}
            <code className="font-mono">POST /v3/memory/operator/provision</code> — that&apos;s a one-time Sui tx.
          </p>
        </div>
      </div>
    </div>
  );
}

function ConnectGate() {
  return (
    <div className="mx-auto max-w-xl rounded-xl border border-dashed border-outline-variant/40 bg-surface-container-low p-12 text-center">
      <span className="material-symbols-outlined text-[36px] text-primary">school</span>
      <h1 className="mt-2 font-headline text-2xl font-bold">Connect to train</h1>
      <p className="mt-2 text-sm text-on-surface-variant">
        Your Sui wallet owns the MemWal namespace. Connect to write encrypted knowledge.
      </p>
    </div>
  );
}
