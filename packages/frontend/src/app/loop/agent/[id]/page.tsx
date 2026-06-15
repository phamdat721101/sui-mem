'use client';

import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useCurrentAccount, useSuiClient } from '@mysten/dapp-kit';
import { AGENT_BACKEND_URL } from '@/lib/api';
import { useSuiSponsoredPay, type SuiSponsoredPayResult } from '@/hooks/useSuiSponsoredPay';

interface AgentFields {
  seller: string;
  manifest_walrus_blob_id: string;
  per_iter_default_micro_usdc: string;
  max_iter_per_job: string;
  seller_bps: string;
  compute_bps: string;
  platform_bps: string;
  reputation_score: string;
  completed_jobs: string;
  revoked: boolean;
}

const USDC_TYPE = process.env.NEXT_PUBLIC_OPENX_USDC_COIN_TYPE ?? '';

export default function LoopAgentDetailPage() {
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const account = useCurrentAccount();
  const client = useSuiClient();
  const initialMode = (search?.get('mode') as 'x402' | 'loop' | null) ?? 'x402';
  const initialQ = search?.get('q') ?? '';
  const [agent, setAgent] = useState<AgentFields | null>(null);
  const [text, setText] = useState(initialQ);
  const [paymentCoinObjectId, setPaymentCoinObjectId] = useState('');
  const [result, setResult] = useState<SuiSponsoredPayResult | null>(null);
  const { payAndRun, busy, error } = useSuiSponsoredPay();

  useEffect(() => {
    if (!params?.id) return;
    fetch(`${AGENT_BACKEND_URL}/v3/loop/agents/${params.id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setAgent(j as AgentFields))
      .catch(() => undefined);
  }, [params?.id]);

  useEffect(() => {
    if (!account?.address || !USDC_TYPE) return;
    client
      .getCoins({ owner: account.address, coinType: USDC_TYPE, limit: 1 })
      .then((r) => r.data[0] && setPaymentCoinObjectId(r.data[0].coinObjectId))
      .catch(() => undefined);
  }, [account?.address, client]);

  const onPay = async () => {
    if (!params?.id || !paymentCoinObjectId) return;
    const r = await payAndRun({
      agentObjectId: params.id,
      paymentCoinObjectId,
      text,
    }).catch(() => null);
    if (r) setResult(r);
  };

  if (!agent) return <div className="text-on-surface-variant">Loading agent…</div>;

  const priceUsd = (Number(agent.per_iter_default_micro_usdc) / 1_000_000).toFixed(4);
  const splits = `${Number(agent.seller_bps) / 100}/${Number(agent.compute_bps) / 100}/${Number(agent.platform_bps) / 100}`;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="space-y-2">
        <span className="font-mono text-[11px] text-on-surface-variant">
          {params?.id?.slice(0, 12)}…{params?.id?.slice(-6)}
        </span>
        <h1 className="font-headline text-3xl font-bold">Loop Agent</h1>
        <div className="flex flex-wrap gap-2 text-xs">
          <Pill>Seller {String(agent.seller).slice(0, 10)}…</Pill>
          <Pill>${priceUsd} / iter</Pill>
          <Pill>max {agent.max_iter_per_job} iters</Pill>
          <Pill>splits {splits} %</Pill>
          {agent.revoked && <Pill error>Revoked</Pill>}
        </div>
      </header>

      {initialMode === 'x402' && (
        <section className="rounded-xl border border-outline-variant/30 bg-surface p-5 space-y-3">
          <h2 className="font-headline text-lg font-semibold">Mode A — Pay & Run (x402 fast lane)</h2>
          <textarea
            rows={6}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Describe the task or paste content to translate / summarize…"
            className="w-full rounded-md bg-surface-container-low px-3 py-2 text-on-surface focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-on-surface-variant">
            <span>Payment coin: {paymentCoinObjectId ? `${paymentCoinObjectId.slice(0, 10)}…` : '(no USDC)'}</span>
            <button
              type="button"
              onClick={onPay}
              disabled={busy || !text.trim() || !paymentCoinObjectId}
              className="rounded-full bg-primary px-4 py-1.5 text-xs font-mono text-on-primary disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? 'Settling…' : `Pay $${priceUsd} & run`}
            </button>
          </div>
          {error && <div className="rounded-md border border-error/40 bg-error/10 p-2 text-xs text-error">{error}</div>}
          {result && (
            <div className="space-y-1 rounded-md border border-primary/40 bg-primary/10 p-3 text-xs">
              <div>✓ Settled — tx <span className="font-mono">{result.tx_digest.slice(0, 16)}…</span></div>
              <div>Walrus blob <span className="font-mono">{result.response_walrus_blob_id}</span></div>
              <div>
                Attestation {result.attestation.verified ? '✓' : '✗'} · {result.attestation.provider} · {result.runner_memory_ms}ms
              </div>
              <div className="text-on-surface-variant">
                Decrypt the response in your browser via the Seal threshold servers (popup #2 of the day).
              </div>
            </div>
          )}
        </section>
      )}

      {initialMode === 'loop' && (
        <section className="rounded-xl border border-outline-variant/30 bg-surface p-5 space-y-3">
          <h2 className="font-headline text-lg font-semibold">Mode B — Loop hire (multi-iter)</h2>
          <p className="text-sm text-on-surface-variant">
            Hire flow ships in the seller dashboard for v0.0; Mode B end-to-end is wired through
            <code className="font-mono"> /loop/job/[objectId]</code>. Coming up next.
          </p>
        </section>
      )}
    </div>
  );
}

function Pill({ children, error }: { children: React.ReactNode; error?: boolean }) {
  return (
    <span
      className={`rounded-full border px-2 py-0.5 font-mono text-[10px] ${
        error
          ? 'border-error/40 bg-error/10 text-error'
          : 'border-outline-variant/40 bg-surface-container-high text-on-surface-variant'
      }`}
    >
      {children}
    </span>
  );
}
