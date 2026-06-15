'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

/**
 * AgentRecentCalls — anonymized public ledger feed.
 *
 * Polls `GET /v3/agents/:slug/recent-calls?limit=N` every 15s. Server-side
 * 5-second cache means the actual hit rate on Postgres stays bounded even
 * with many open browsers.
 *
 * SOLID:
 *  - SRP: render + poll. No data normalization beyond what the API already
 *    returned (anonymized payer, ISO timestamp).
 *  - DIP: takes a `slug` only. Pages that own the slug pass it down.
 */

interface RecentCallRow {
  tx_hash: string;
  payer: string;
  amount_usdc: string;
  method: string;
  network: string;
  settled_at: string;
}

const POLL_MS = 15_000;

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function explorerUrl(network: string, txHash: string): string | null {
  if (network === 'demo' || txHash.startsWith('demo:')) return null;
  if (network === 'sui-testnet') return `https://suiscan.xyz/testnet/tx/${txHash}`;
  if (network === 'sui-mainnet') return `https://suiscan.xyz/mainnet/tx/${txHash}`;
  return null;
}

export function AgentRecentCalls({ slug, limit = 10 }: { slug: string; limit?: number }) {
  const [rows, setRows] = useState<RecentCallRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval>;

    async function tick() {
      try {
        const r = await api.getAgentRecentCalls(slug, limit);
        if (!cancelled) {
          setRows(r.rows);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    }
    void tick();
    timer = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [slug, limit]);

  return (
    <div className="space-y-3 rounded-xl border border-outline-variant/30 bg-surface p-5">
      <div className="flex items-center justify-between">
        <h3 className="font-headline text-sm font-semibold uppercase tracking-wider text-on-surface-variant">
          Recent calls
        </h3>
        <span className="font-mono text-[10px] text-on-surface-variant">live · 15s</span>
      </div>
      {error && <p className="font-mono text-[11px] text-error">{error}</p>}
      {!rows && !error && <p className="font-mono text-[11px] text-on-surface-variant">Loading…</p>}
      {rows && rows.length === 0 && (
        <p className="font-mono text-[11px] text-on-surface-variant">
          No calls yet — be the first to hire this agent.
        </p>
      )}
      {rows && rows.length > 0 && (
        <ul className="space-y-2">
          {rows.map((r) => {
            const url = explorerUrl(r.network, r.tx_hash);
            const amount = Number(r.amount_usdc);
            const isDemo = r.method === 'demo';
            return (
              <li
                key={`${r.tx_hash}-${r.settled_at}`}
                className="flex items-center justify-between gap-3 rounded-lg border border-outline-variant/20 bg-surface-container-low px-3 py-2"
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] text-on-surface">{r.payer}</span>
                    {isDemo ? (
                      <span className="rounded border border-outline-variant/30 px-1 py-px font-mono text-[9px] text-on-surface-variant">
                        demo
                      </span>
                    ) : (
                      <span className="rounded border border-secondary/30 px-1 py-px font-mono text-[9px] text-secondary">
                        paid
                      </span>
                    )}
                  </div>
                  <div className="font-mono text-[10px] text-on-surface-variant">
                    {relativeTime(r.settled_at)} · {r.network}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-[11px] text-on-surface">
                    {isDemo ? '—' : `$${amount.toFixed(4)}`}
                  </div>
                  {url && (
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-[10px] text-primary hover:underline"
                    >
                      tx ↗
                    </a>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
