'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useCurrentAccount } from '@mysten/dapp-kit';
import { api, type TrainingEvent } from '@/lib/api';

/**
 * /studio/agent/[slug]/train — per-agent training surface (PRD-F).
 *
 *   Owner-gate: the seller dashboard is the source of truth. If the
 *   connected wallet does not own the slug, render 403 + back link.
 *
 *   Three actions: write knowledge (textarea → memwal.remember), upload
 *   a document (Walrus client-direct PUT → record), run a reflection loop
 *   (1-click Bedrock self-critique → write to L5).
 *
 *   History feed re-fetches after every action — no optimistic update.
 *   Each row shows a Walrus aggregator URL and/or a Sui explorer URL when
 *   the on-chain digest is real (not a mock-fallback `local:` id).
 *
 * SOLID:
 *   - SRP: render + dispatch. Wire shapes come from `lib/api`.
 *   - DIP: page knows nothing about MemWal namespaces — backend owns them.
 */

const LEVELS = [
  { value: 2 as const, label: 'L2 semantic — facts + concepts' },
  { value: 3 as const, label: 'L3 long-term — durable knowledge' },
  { value: 4 as const, label: 'L4 workflow — task patterns' },
];

export default function AgentTrainPage() {
  const account = useCurrentAccount();
  const params = useParams<{ slug: string }>();
  const slug = params?.slug ?? '';
  if (!account) return <ConnectGate />;
  if (!slug) return null;
  return <TrainContent wallet={account.address} slug={slug} />;
}

function TrainContent({ wallet, slug }: { wallet: string; slug: string }) {
  const [events, setEvents] = useState<TrainingEvent[] | null>(null);
  const [notOwner, setNotOwner] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const r = await api.getAgentTrainingEvents(wallet, slug, 50);
      setEvents(r.events);
      setNotOwner(r.notOwner);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [wallet, slug]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (notOwner) {
    return (
      <div className="mx-auto max-w-xl rounded-xl border border-error/30 bg-error/10 p-12 text-center">
        <span className="material-symbols-outlined text-[36px] text-error">block</span>
        <h1 className="mt-2 font-headline text-2xl font-bold">Not your agent</h1>
        <p className="mt-2 text-sm text-on-surface-variant">
          Only the agent owner can open this training page.
        </p>
        <Link href="/studio" className="mt-3 inline-block text-sm text-primary hover:underline">
          ← Back to studio
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-3">
        <div>
          <Link href="/studio" className="font-mono text-xs text-on-surface-variant hover:text-primary">
            ← Studio
          </Link>
          <h1 className="mt-2 font-headline text-3xl font-bold">Train · {slug}</h1>
          <p className="text-sm text-on-surface-variant">
            Write knowledge, attach documents, and run reflection loops. Every action is signed
            into your MemWal namespaces and surfaced in the history feed below with explorer URLs.
          </p>
        </div>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <KnowledgeBox slug={slug} wallet={wallet} onDone={refresh} />
        <UploadBox slug={slug} wallet={wallet} onDone={refresh} />
      </div>

      <ReflectionBox slug={slug} wallet={wallet} onDone={refresh} />

      <HistoryFeed events={events} error={error} onRetry={refresh} />
    </div>
  );
}

// ─── Knowledge writer ──────────────────────────────────────────────────

function KnowledgeBox({
  slug, wallet, onDone,
}: { slug: string; wallet: string; onDone: () => void }) {
  const [text, setText] = useState('');
  const [level, setLevel] = useState<2 | 3 | 4>(3);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (busy || text.trim().length < 4) return;
    setBusy(true);
    setErr(null);
    try {
      await api.sellerAgentRemember(wallet, slug, text.trim(), level);
      setText('');
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3 rounded-xl border border-outline-variant/30 bg-surface p-5">
      <h2 className="font-headline text-base font-semibold">Write knowledge</h2>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={5}
        maxLength={4000}
        placeholder="Type or paste any text. Each entry becomes one MemWal blob your agent recalls."
        className="w-full resize-y rounded-lg border border-outline-variant/40 bg-surface-container-low px-3 py-2 text-sm focus:border-primary/60 focus:outline-none"
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <select
          value={level}
          onChange={(e) => setLevel(Number(e.target.value) as 2 | 3 | 4)}
          className="rounded-lg border border-outline-variant/40 bg-surface-container-low px-2 py-1 font-mono text-xs"
        >
          {LEVELS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
        </select>
        <button
          type="button"
          onClick={submit}
          disabled={busy || text.trim().length < 4}
          className="rounded-full bg-primary px-4 py-1.5 font-mono text-[11px] uppercase tracking-wider text-on-primary hover:opacity-90 disabled:opacity-50"
        >
          {busy ? 'Writing…' : 'Remember'}
        </button>
      </div>
      {err && <p className="font-mono text-[11px] text-error">{err}</p>}
    </section>
  );
}

// ─── Document upload ───────────────────────────────────────────────────

function UploadBox({
  slug, wallet, onDone,
}: { slug: string; wallet: string; onDone: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [last, setLast] = useState<string | null>(null);

  async function handleFile(file: File) {
    setBusy(true);
    setErr(null);
    try {
      const minted = await api.mintAgentUpload(slug, {
        original_name: file.name,
        mime_type: file.type || 'application/octet-stream',
        size_bytes: file.size,
      });
      const blobId = await api.uploadFileToWalrus(minted.publisher_url, file);
      await api.sellerAgentUploadConfirm(wallet, slug, {
        walrus_blob_id: blobId,
        original_name: file.name,
        mime_type: file.type || 'application/octet-stream',
        size_bytes: file.size,
      });
      setLast(file.name);
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <section className="space-y-3 rounded-xl border border-outline-variant/30 bg-surface p-5">
      <h2 className="font-headline text-base font-semibold">Attach a document</h2>
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files?.[0];
          if (f) void handleFile(f);
        }}
        className="flex items-center justify-between rounded-lg border border-dashed border-outline-variant/50 bg-surface-container-low p-4 hover:border-primary/40"
      >
        <span className="font-mono text-[11px] text-on-surface-variant">
          {busy ? 'Uploading to Walrus…' : last ? `Last: ${last}` : 'Drag a file or'}
        </span>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="rounded-full border border-outline-variant/40 px-3 py-1 font-mono text-[10px] uppercase hover:border-primary/40 hover:text-primary disabled:opacity-50"
        >
          Choose file
        </button>
        <input
          ref={fileRef}
          type="file"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
          }}
          accept="text/*,application/json,application/pdf,application/csv,image/*"
        />
      </div>
      <p className="font-mono text-[10px] text-on-surface-variant">
        Browser PUTs the file directly to Walrus — no bytes traverse our API.
      </p>
      {err && <p className="font-mono text-[11px] text-error">{err}</p>}
    </section>
  );
}

// ─── Reflection loop ────────────────────────────────────────────────────

function ReflectionBox({
  slug, wallet, onDone,
}: { slug: string; wallet: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.sellerAgentTrainingLoop(wallet, slug);
      setLast(r.critique);
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3 rounded-xl border border-secondary/30 bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-headline text-base font-semibold">Reflection loop</h2>
          <p className="text-sm text-on-surface-variant">
            One click runs a Bedrock self-critique against your agent&apos;s persona and writes the
            result to L5 (reflective). Use the output to decide what knowledge to add next.
          </p>
        </div>
        <button
          type="button"
          onClick={run}
          disabled={busy}
          className="rounded-full bg-secondary px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-on-primary hover:opacity-90 disabled:opacity-50"
        >
          {busy ? 'Reflecting…' : 'Run iteration'}
        </button>
      </div>
      {last && (
        <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-surface-container-low p-3 font-mono text-[12px] text-on-surface">
          {last}
        </pre>
      )}
      {err && <p className="font-mono text-[11px] text-error">{err}</p>}
    </section>
  );
}

// ─── History feed ──────────────────────────────────────────────────────

const TYPE_ICON: Record<TrainingEvent['event_type'], string> = {
  upload: 'upload_file',
  remember: 'edit_note',
  reflect: 'auto_awesome',
  settle: 'paid',
};

function HistoryFeed({
  events, error, onRetry,
}: { events: TrainingEvent[] | null; error: string | null; onRetry: () => void }) {
  return (
    <section className="space-y-3 rounded-xl border border-outline-variant/30 bg-surface p-5">
      <div className="flex items-center justify-between">
        <h2 className="font-headline text-base font-semibold">History</h2>
        <button
          type="button"
          onClick={onRetry}
          className="rounded-full border border-outline-variant/40 px-3 py-1 font-mono text-[10px] uppercase hover:border-primary/40 hover:text-primary"
        >
          Refresh
        </button>
      </div>
      {error && <p className="font-mono text-[11px] text-error">{error}</p>}
      {events === null && !error && <p className="font-mono text-[11px] text-on-surface-variant">Loading…</p>}
      {events && events.length === 0 && (
        <p className="font-mono text-[11px] text-on-surface-variant">
          No actions yet. Write knowledge, attach a document, or run a reflection iteration above.
        </p>
      )}
      {events && events.length > 0 && (
        <ul className="space-y-2">
          {events.map((e, i) => (
            <li
              key={`${e.created_at}-${i}`}
              className="rounded-lg border border-outline-variant/20 bg-surface-container-low p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-2">
                  <span className="material-symbols-outlined text-[18px] text-primary" aria-hidden>
                    {TYPE_ICON[e.event_type]}
                  </span>
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="rounded border border-outline-variant/30 px-1.5 py-px font-mono text-[10px] uppercase text-on-surface-variant">
                        {e.event_type}
                      </span>
                      {e.namespace && (
                        <span className="font-mono text-[10px] text-on-surface-variant">{e.namespace}</span>
                      )}
                    </div>
                    {e.summary && (
                      <p className="line-clamp-2 text-sm text-on-surface">{e.summary}</p>
                    )}
                  </div>
                </div>
                <span className="shrink-0 font-mono text-[10px] text-on-surface-variant">
                  {new Date(e.created_at).toLocaleString()}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-3 border-t border-outline-variant/20 pt-2 text-[10px]">
                {e.explorer_urls.walrus && (
                  <a href={e.explorer_urls.walrus} target="_blank" rel="noreferrer"
                    className="font-mono text-primary hover:underline">
                    walrus blob ↗
                  </a>
                )}
                {e.explorer_urls.sui && (
                  <a href={e.explorer_urls.sui} target="_blank" rel="noreferrer"
                    className="font-mono text-primary hover:underline">
                    sui tx ↗
                  </a>
                )}
                {!e.explorer_urls.walrus && !e.explorer_urls.sui && e.walrus_blob_id && (
                  <span className="font-mono text-on-surface-variant">
                    {e.walrus_blob_id.startsWith('local:') ? 'mock-fallback' : 'no explorer link'}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ConnectGate() {
  return (
    <div className="mx-auto max-w-xl rounded-xl border border-dashed border-outline-variant/40 bg-surface-container-low p-12 text-center">
      <span className="material-symbols-outlined text-[36px] text-primary">school</span>
      <h1 className="mt-2 font-headline text-2xl font-bold">Connect to train</h1>
      <p className="mt-2 text-sm text-on-surface-variant">
        Your Sui wallet owns this agent. Connect it to write knowledge, attach documents, and run
        reflection iterations.
      </p>
    </div>
  );
}
