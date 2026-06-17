'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import { api, AGENT_BACKEND_URL, type Listing, type AgentPaymentInfo } from '@/lib/api';
import { AgentRecentCalls } from '@/components/AgentRecentCalls';

/**
 * /agent/[id]/run — buyer task workspace.
 *
 * Flow:
 *   1. Buyer types a task description.
 *   2. (Optional) Buyer drops files. The browser PUTs the bytes directly
 *      to Walrus — no API proxy, no server memory pressure.
 *   3. Click "Try free" (5/day per IP) → POST /v3/agents/:slug/try.
 *      Click "Pay & Run" → reuse the existing Sui sponsored-tx hook.
 *   4. Answer renders below; the recent-calls sidebar reflects the new row
 *      within 15s.
 *
 * SOLID:
 *  - SRP: this page owns the task UI. Inference / settle / Walrus details
 *    live in the API helpers (`@/lib/api`).
 *  - OCP: switching the paid path to a different rail = swap the helper
 *    call; the UI shape is unchanged.
 */

interface PendingUpload {
  upload_id: string;
  blob_id: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  extraction_status: string;
}

interface AnswerShape {
  answer: string;
  citations: Array<{ source?: string; snippet: string }>;
  attestation: { provider: string; quote: string; verified: boolean; issuedAt: string };
  settled: { tx_digest: string; amount_micro_usdc: string; network: string } | null;
}

export default function AgentRunPage() {
  const params = useParams<{ id: string }>();
  const slug = params?.id ?? '';

  const account = useCurrentAccount();
  const suiClient = useSuiClient();
  const { mutateAsync: signAndExecuteTransaction } = useSignAndExecuteTransaction();

  const [listing, setListing] = useState<Listing | null>(null);
  const [paymentInfo, setPaymentInfo] = useState<AgentPaymentInfo | null>(null);
  const [question, setQuestion] = useState('');
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const [uploading, setUploading] = useState(false);
  const [running, setRunning] = useState(false);
  const [answer, setAnswer] = useState<AnswerShape | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!slug) return;
    api.listing(slug).then(setListing);
    api.agentPaymentInfo(slug).then(setPaymentInfo).catch(() => undefined);
  }, [slug]);

  async function handleFiles(files: FileList | null) {
    if (!files || !files.length) return;
    if (uploads.length + files.length > 5) {
      setError('Up to 5 files per task');
      return;
    }
    setError(null);
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const minted = await api.mintAgentUpload(slug, {
          original_name: file.name,
          mime_type: file.type || 'application/octet-stream',
          size_bytes: file.size,
        });
        const blobId = await api.uploadFileToWalrus(minted.publisher_url, file);
        const confirmed = await api.confirmAgentUpload(slug, {
          blob_id: blobId,
          original_name: file.name,
          mime_type: file.type || 'application/octet-stream',
          size_bytes: file.size,
        });
        setUploads((u) => [
          ...u,
          {
            upload_id: confirmed.upload_id,
            blob_id: blobId,
            original_name: file.name,
            mime_type: file.type || 'application/octet-stream',
            size_bytes: file.size,
            extraction_status: confirmed.extraction_status,
          },
        ]);
      }
    } catch (e) {
      setError(`Upload failed: ${(e as Error).message}`);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  function removeUpload(id: string) {
    setUploads((u) => u.filter((x) => x.upload_id !== id));
  }

  async function runFree() {
    if (!question.trim()) {
      setError('Type a question first.');
      return;
    }
    setError(null);
    setRunning(true);
    setAnswer(null);
    try {
      const r = await api.tryAgentFree(slug, {
        question: question.trim(),
        upload_ids: uploads.map((u) => u.upload_id),
      });
      setAnswer(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  // ─── Self-settled pay flow ───────────────────────────────────────────
  // Buyer signs AND executes a single PTB that splits a USDC coin and pays
  // seller (95%) + platform (5%) directly. Buyer pays their own SUI gas.
  // No sponsor wallet, no 402 dance — just one wallet popup. After the tx
  // confirms, we POST the digest to /v3/agents/:slug/try and the server
  // verifies on-chain via Sui RPC before running inference.
  //
  // SOLID: this is the cleanest paywall protocol — minimum trust surface
  // (server only reads the chain, never holds a buyer's coin in transit).
  async function payAndRun() {
    if (!question.trim()) return setError('Type a question first.');
    if (!account?.address) return setError('Connect a Sui wallet first.');
    if (!paymentInfo?.asset_coin_type) return setError('Agent has no USDC coin type configured.');
    if (!paymentInfo.price_usdc) return setError('Agent has no USDC price configured.');
    if (!paymentInfo.platform_treasury) return setError('Platform treasury not configured on backend.');

    setError(null);
    setRunning(true);
    setAnswer(null);
    try {
      // 1. Find a USDC coin in the buyer's wallet with sufficient balance.
      const totalMicro = BigInt(Math.round(Number(paymentInfo.price_usdc) * 1_000_000));
      const platformMicro = (totalMicro * BigInt(paymentInfo.platform_bps)) / 10_000n;
      const sellerMicro = totalMicro - platformMicro;

      const coins = await suiClient.getCoins({
        owner: account.address,
        coinType: paymentInfo.asset_coin_type,
      });
      const coin = coins.data.find((c) => BigInt(c.balance) >= totalMicro);
      if (!coin) {
        throw new Error(
          `Need at least ${paymentInfo.price_usdc} USDC in wallet (asset ${paymentInfo.asset_coin_type.split('::').pop()}).`,
        );
      }

      // 2. Build a PTB that splits the coin and transfers seller + platform cuts.
      const tx = new Transaction();
      const [sellerCoin, platformCoin] = tx.splitCoins(tx.object(coin.coinObjectId), [
        sellerMicro,
        platformMicro,
      ]);
      tx.transferObjects([sellerCoin], paymentInfo.payee_address);
      tx.transferObjects([platformCoin], paymentInfo.platform_treasury);

      // 3. Buyer signs + executes (one wallet popup, buyer pays gas in SUI).
      // Cast through `unknown` to bridge the dual Transaction type version
      // between @mysten/sui and @mysten/wallet-standard's nested copy.
      const result = await signAndExecuteTransaction({
        transaction: tx as unknown as Parameters<typeof signAndExecuteTransaction>[0]['transaction'],
      });
      const settledTxDigest = result.digest;

      // 4. Hand the digest to the server. It verifies on-chain + runs inference.
      const r = await fetch(`${AGENT_BACKEND_URL}/v3/agents/${encodeURIComponent(slug)}/try`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Buyer-Address': account.address },
        body: JSON.stringify({
          q: question.trim(),
          upload_ids: uploads.map((u) => u.upload_id),
          buyer_address: account.address,
          settled_tx_digest: settledTxDigest,
        }),
      });
      if (!r.ok) throw new Error(`server rejected payment ${r.status}: ${await r.text()}`);
      setAnswer((await r.json()) as AnswerShape);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  const price = listing?.pricing?.sui_usdc ?? listing?.pricing?.x402 ?? null;

  return (
    <div className="grid gap-6 md:grid-cols-3">
      <div className="min-w-0 space-y-5 md:col-span-2">
        <div className="flex items-start gap-4 rounded-xl border border-outline-variant/30 bg-surface p-6">
          <div className="flex h-14 w-14 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <span className="material-symbols-outlined text-[28px]">play_arrow</span>
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-headline text-2xl font-bold">Run a task</h1>
              <span className="rounded-full border border-secondary/30 bg-secondary/10 px-2 py-0.5 font-mono text-[10px] text-secondary">
                {listing?.title ?? slug}
              </span>
            </div>
            <p className="font-mono text-xs text-on-surface-variant">
              {(() => {
                const cap = paymentInfo?.daily_request_cap;
                const priceStr = price ? Number(price).toFixed(4) : '?';
                if (cap === undefined) return `Loading pricing…`;
                if (cap === 0) return `No free tier · $${priceStr} USDC per call`;
                return `Free tier: ${cap} calls/day · paid: $${priceStr} USDC/call`;
              })()}
            </p>
          </div>
          <Link
            href={`/agent/${slug}`}
            className="rounded-full border border-outline-variant/40 px-3 py-1 font-mono text-[10px] uppercase text-on-surface-variant hover:border-primary/40 hover:text-primary"
          >
            ← Detail
          </Link>
        </div>

        <div className="space-y-3 rounded-xl border border-outline-variant/30 bg-surface p-5">
          <label htmlFor="task-q" className="block font-mono text-[11px] uppercase tracking-wider text-on-surface-variant">
            What do you want this agent to do?
          </label>
          <textarea
            id="task-q"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            rows={5}
            placeholder="Describe the task. Attach docs below for grounded answers."
            className="block w-full resize-y rounded-lg border border-outline-variant/40 bg-surface-container-low p-3 font-mono text-sm text-on-surface focus:border-primary/60 focus:outline-none"
          />

          <div className="space-y-2">
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                void handleFiles(e.dataTransfer.files);
              }}
              className="flex items-center justify-between rounded-lg border border-dashed border-outline-variant/50 bg-surface-container-low p-4 hover:border-primary/40"
            >
              <span className="font-mono text-[11px] text-on-surface-variant">
                Drag files here or
              </span>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                className="rounded-full border border-outline-variant/40 px-3 py-1 font-mono text-[10px] uppercase hover:border-primary/40 hover:text-primary disabled:opacity-50"
              >
                {uploading ? 'Uploading…' : 'Choose files'}
              </button>
              <input
                ref={fileRef}
                type="file"
                multiple
                hidden
                onChange={(e) => void handleFiles(e.target.files)}
                accept="text/*,application/json,application/csv,application/x-yaml,application/xml,application/pdf,image/*"
              />
            </div>
            {uploads.length > 0 && (
              <ul className="space-y-1">
                {uploads.map((u) => (
                  <li
                    key={u.upload_id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-outline-variant/20 bg-surface-container-low px-3 py-1.5"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-mono text-[11px] text-on-surface">{u.original_name}</div>
                      <div className="font-mono text-[10px] text-on-surface-variant">
                        {u.mime_type} · {Math.round(u.size_bytes / 1024)} KB · {u.extraction_status}
                      </div>
                    </div>
                    <button
                      type="button"
                      aria-label={`Remove ${u.original_name}`}
                      onClick={() => removeUpload(u.upload_id)}
                      className="rounded border border-outline-variant/40 px-2 font-mono text-[10px] hover:border-error/60 hover:text-error"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {error && <p className="font-mono text-[11px] text-error">{error}</p>}

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-outline-variant/20 pt-3">
            <span className="font-mono text-[10px] text-on-surface-variant">
              {paymentInfo?.daily_request_cap === 0
                ? account?.address
                  ? `Paid only · click below: your wallet pops up to sign + execute a USDC transfer of $${paymentInfo.price_usdc ?? '?'} (you pay your own SUI gas, no sponsor)`
                  : 'Paid only · connect a Sui wallet to sign + send the USDC transfer (you pay gas in SUI)'
                : 'Free /try uses Seal IBE for brain-blob privacy'}
            </span>
            <div className="flex gap-2">
              {paymentInfo?.daily_request_cap === 0 ? (
                <button
                  type="button"
                  onClick={payAndRun}
                  disabled={running || !question.trim() || !account?.address}
                  className="rounded-full bg-secondary px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-on-secondary hover:opacity-90 disabled:opacity-50"
                  title={!account?.address ? 'Connect a Sui wallet first' : undefined}
                >
                  {running ? 'Settling…' : `Pay $${paymentInfo.price_usdc ?? '?'} USDC`}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={runFree}
                  disabled={running || !question.trim()}
                  className="rounded-full bg-primary px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-on-primary hover:opacity-90 disabled:opacity-50"
                >
                  {running ? 'Running…' : 'Try free'}
                </button>
              )}
            </div>
          </div>
        </div>

        {answer && (
          <div className="space-y-3 rounded-xl border border-secondary/30 bg-surface p-5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-headline text-base font-semibold">Answer</h2>
              <span className="font-mono text-[10px] text-on-surface-variant">
                {answer.attestation.verified ? `✓ ${answer.attestation.provider}` : 'unverified'}
              </span>
            </div>
            <p className="whitespace-pre-wrap text-sm text-on-surface">{answer.answer}</p>
            {answer.citations.length > 0 && (
              <div className="space-y-1 border-t border-outline-variant/20 pt-3">
                <div className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
                  Citations
                </div>
                <ul className="space-y-1">
                  {answer.citations.map((c, i) => (
                    <li key={i} className="font-mono text-[11px] text-on-surface-variant">
                      [{i + 1}] {c.snippet}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {answer.settled && (
              <div className="font-mono text-[10px] text-on-surface-variant">
                tx {answer.settled.tx_digest.slice(0, 10)}…  ·  {answer.settled.network}
              </div>
            )}
          </div>
        )}
      </div>

      <aside className="min-w-0 space-y-4">
        <AgentRecentCalls slug={slug} limit={8} />
        <div className="rounded-xl border border-outline-variant/30 bg-surface p-5">
          <div className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
            For AI integrators
          </div>
          <Link
            href={`/agent/${slug}/integrate`}
            className="mt-2 inline-flex items-center gap-1 text-sm text-primary hover:underline"
          >
            See curl + agent.json →
          </Link>
        </div>
      </aside>
    </div>
  );
}
