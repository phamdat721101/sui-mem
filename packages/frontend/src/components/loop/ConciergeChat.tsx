'use client';

/**
 * ConciergeChat — the homepage concierge UX for OpenX Loops.
 *
 * Free-text intent → ranked candidates with mode badge → per-candidate CTA
 * (Mode A `/loop/agent/:id?mode=x402` direct invoke, Mode B
 * `/loop/agent/:id?mode=loop` hire form). File-attach inlines text content
 * as `--- Attached file: ... ---` markers (cap 60KB) so binary attachments
 * gracefully degrade.
 *
 * SOLID:
 *  - SRP: render + dispatch. The PTB build/sign lives in `useSuiSponsoredPay`.
 *  - DIP: API URL via `AGENT_BACKEND_URL` (existing lib/api.ts).
 */

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AGENT_BACKEND_URL } from '@/lib/api';
import { useCurrentAccount } from '@mysten/dapp-kit';

interface Candidate {
  agent_object_id: string;
  seller: string;
  title: string;
  short_description: string;
  per_iter_default_micro_usdc: string;
  max_iter_per_job: number;
  tags: string[];
  mode: 'x402' | 'loop';
  score: number;
  reason: string;
}

interface ConciergeResponse {
  candidates: Candidate[];
  explain: string;
}

const FILE_TEXT_LIMIT = 60_000;

export function ConciergeChat() {
  const router = useRouter();
  const account = useCurrentAccount();
  const [input, setInput] = useState('');
  const [attachedText, setAttachedText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ConciergeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onPick = useCallback((file: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const t = String(reader.result ?? '').slice(0, FILE_TEXT_LIMIT);
      setAttachedText(`--- Attached file: ${file.name} ---\n${t}\n--- End attached file ---`);
    };
    reader.onerror = () => setError('Could not read file');
    reader.readAsText(file);
  }, []);

  const submit = useCallback(async () => {
    if (!input.trim() && !attachedText) return;
    setBusy(true);
    setError(null);
    try {
      const message = [input.trim(), attachedText].filter(Boolean).join('\n\n');
      const r = await fetch(`${AGENT_BACKEND_URL}/v3/loop/concierge/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, buyer_address: account?.address }),
      });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const j = (await r.json()) as ConciergeResponse;
      setResult(j);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [input, attachedText, account?.address]);

  const choose = (c: Candidate) => {
    const initial = (input.trim() + (attachedText ? `\n${attachedText}` : '')).trim();
    const url = `/loop/agent/${c.agent_object_id}?mode=${c.mode}${initial ? `&q=${encodeURIComponent(initial.slice(0, 1000))}` : ''}`;
    router.push(url);
  };

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-outline-variant/40 bg-surface-container-low p-4">
        <div className="mb-2 text-xs font-mono uppercase tracking-wider text-on-surface-variant">
          chat → find an agent → sign once → own your privacy
        </div>
        <textarea
          rows={3}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Describe a task. e.g. 'Translate this NDA to Vietnamese' — attach a file for context."
          className="w-full resize-none bg-transparent font-headline text-base leading-relaxed text-on-surface placeholder:text-on-surface-variant focus:outline-none"
        />
        {attachedText && (
          <div className="mt-2 flex items-center justify-between rounded-lg bg-surface-container px-3 py-1.5 text-xs">
            <span className="font-mono text-on-surface-variant">📎 file context attached ({attachedText.length} chars)</span>
            <button
              type="button"
              onClick={() => setAttachedText(null)}
              className="text-on-surface-variant hover:text-error"
            >
              ✕
            </button>
          </div>
        )}
        <div className="mt-3 flex items-center justify-between">
          <label className="cursor-pointer rounded-full border border-outline-variant/40 px-3 py-1.5 text-xs text-on-surface-variant hover:border-primary/40 hover:text-primary">
            <span className="material-symbols-outlined mr-1 text-[14px] align-middle">attach_file</span>
            Attach file
            <input
              type="file"
              className="hidden"
              onChange={(e) => e.target.files && e.target.files[0] && onPick(e.target.files[0])}
            />
          </label>
          <button
            type="button"
            onClick={submit}
            disabled={busy || (!input.trim() && !attachedText)}
            className="rounded-full bg-primary px-4 py-1.5 text-xs font-mono text-on-primary disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? 'Searching…' : 'Find an agent'}
          </button>
        </div>
      </div>

      {error && <div className="rounded-lg border border-error/40 bg-error/10 p-3 text-sm text-error">{error}</div>}

      {result && (
        <div className="space-y-2">
          <div className="text-xs font-mono uppercase text-on-surface-variant">{result.explain}</div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {result.candidates.map((c) => (
              <button
                key={c.agent_object_id}
                type="button"
                onClick={() => choose(c)}
                className="agent-card-border encryption-glow flex flex-col gap-2 rounded-xl bg-surface p-4 text-left"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="line-clamp-1 font-headline text-sm font-semibold text-on-surface">
                    {c.title}
                  </span>
                  <ModeBadge mode={c.mode} />
                </div>
                <p className="line-clamp-2 text-xs text-on-surface-variant">{c.short_description}</p>
                <div className="mt-auto flex items-center justify-between text-[11px] font-mono text-on-surface-variant">
                  <span>${(Number(c.per_iter_default_micro_usdc) / 1_000_000).toFixed(2)} / iter</span>
                  <span>max {c.max_iter_per_job} iters</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ModeBadge({ mode }: { mode: 'x402' | 'loop' }) {
  if (mode === 'x402') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-secondary/40 bg-secondary/10 px-2 py-0.5 font-mono text-[10px] text-secondary">
        <span className="material-symbols-outlined text-[10px]">bolt</span>
        Pay & Run
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 font-mono text-[10px] text-primary">
      <span className="material-symbols-outlined text-[10px]">all_inclusive</span>
      Loop hire
    </span>
  );
}
