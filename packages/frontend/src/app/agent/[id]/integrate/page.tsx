'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { AGENT_BACKEND_URL, api, priceFromPricing, type Listing } from '@/lib/api';

/**
 * /agent/[id]/integrate — AI-integrator hero.
 *
 * One destination owners share with AI integrators: curl, prompt, bundle
 * JSON, the AgentCard JSON exactly as Cursor / Claude / custom agents will
 * see it, plus a 3-question FAQ. SEO target — distinct URL, distinct intent.
 *
 * SOLID:
 *  - SRP: render-only. No side effects beyond the agent.json fetch.
 *  - DIP: copy blocks compose `AGENT_BACKEND_URL` + the slug; no hard-coded
 *    domains.
 */

interface AgentCardJson {
  name: string;
  description: string;
  url: string;
  payTo: string;
  chain: string;
  asset: string | null;
  tools: Array<{ name: string; description: string; price: string; currency: 'USDC' }>;
  system_prompt: string | null;
}

export default function AgentIntegratePage() {
  const params = useParams<{ id: string }>();
  const slug = params?.id ?? '';

  const [listing, setListing] = useState<Listing | null>(null);
  const [card, setCard] = useState<AgentCardJson | null>(null);

  useEffect(() => {
    if (!slug) return;
    void api.listing(slug).then(setListing);
    void api.getAgentCard(slug).then(setCard).catch(() => undefined);
  }, [slug]);

  if (!slug) return null;

  const url = `${AGENT_BACKEND_URL}/api/v1/${slug}`;
  const price = priceFromPricing(listing?.pricing);
  const priceDecimal = price?.amount ?? '0.01';

  const curl = `curl -X POST '${url}' \\
  -H 'Content-Type: application/json' \\
  -H 'X-Buyer-Address: 0xyour_sui_address' \\
  -d '{"question":"YOUR QUESTION","payment_coin_object_id":"0x..."}'`;

  const cardCurl = `curl ${url}/.well-known/agent.json`;

  const bundleSnippet = JSON.stringify(
    {
      tool: 'ask',
      agent_url: url,
      price_usdc: priceDecimal,
      currency: 'USDC',
      args: { question: '{{user_input}}', uploadIds: [] },
    },
    null,
    2,
  );

  const prompt = listing
    ? buildPrompt(listing, url, priceDecimal)
    : 'Loading…';

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-4 rounded-xl border border-primary/30 bg-surface p-6">
        <div className="flex h-14 w-14 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <span className="material-symbols-outlined text-[28px]">terminal</span>
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-headline text-2xl font-bold">Integrate this agent</h1>
            <span className="rounded-full border border-secondary/30 bg-secondary/10 px-2 py-0.5 font-mono text-[10px] text-secondary">
              {listing?.title ?? slug}
            </span>
          </div>
          <p className="font-mono text-xs text-on-surface-variant">
            Pay-per-call · ${Number(priceDecimal).toFixed(4)} USDC · Sui · Seal-attested
          </p>
        </div>
        <Link
          href={`/agent/${slug}`}
          className="rounded-full border border-outline-variant/40 px-3 py-1 font-mono text-[10px] uppercase text-on-surface-variant hover:border-primary/40 hover:text-primary"
        >
          ← Detail
        </Link>
      </div>

      <Block title="curl" body={curl} />
      <Block title="agent.json (auto-discovery)" body={cardCurl} extra={
        card ? <pre className="overflow-x-auto rounded-lg bg-surface-container-low p-3 font-mono text-[11px] text-on-surface-variant">
          <code>{JSON.stringify(card, null, 2)}</code>
        </pre> : null
      } />
      <Block title="System prompt for your AI" body={prompt} multiline />
      <Block title="Bundle / tool snippet" body={bundleSnippet} multiline />

      <div className="space-y-3 rounded-xl border border-outline-variant/30 bg-surface p-5">
        <h2 className="font-headline text-base font-semibold">FAQ</h2>
        <Faq q="How does payment work?" a="Send USDC on Sui via x402-style sponsored transactions. The OpenX sponsor pays gas; you sign the payment PTB. The first call returns 402 with the unsigned PTB; sign and resubmit with X-PAYMENT." />
        <Faq q="How is privacy enforced?" a="Brain blobs are encrypted with AES-256-GCM in your browser; the symmetric key is wrapped under a per-agent Seal IBE policy. The threshold-derived decryption key is only released after the Sui payment receipt is on-chain. Inference runs on AWS Bedrock (Claude); the OpenX server holds the brain ciphertext only — Seal alone gates plaintext access." />
        <Faq q="What about uploads?" a="POST /v3/agents/<slug>/uploads/mint to get a Walrus publisher URL, PUT the file directly (no proxy), then POST /v3/agents/<slug>/uploads with the resulting blob_id. Pass upload_ids[] in the question body." />
      </div>
    </div>
  );
}

function Block({ title, body, multiline, extra }: { title: string; body: string; multiline?: boolean; extra?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-3 rounded-xl border border-outline-variant/30 bg-surface p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-headline text-base font-semibold">{title}</h2>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(body);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            } catch { /* ignore */ }
          }}
          className="rounded-full border border-outline-variant/40 px-3 py-1 font-mono text-[10px] uppercase hover:border-primary/40 hover:text-primary"
        >
          {copied ? '✓ copied' : 'Copy'}
        </button>
      </div>
      <pre className={`overflow-x-auto rounded-lg bg-surface-container-low p-3 font-mono text-[12px] ${multiline ? 'whitespace-pre-wrap' : ''}`}>
        <code>{body}</code>
      </pre>
      {extra}
    </div>
  );
}

function Faq({ q, a }: { q: string; a: string }) {
  return (
    <details className="rounded-lg border border-outline-variant/20 bg-surface-container-low p-3">
      <summary className="cursor-pointer font-mono text-xs text-on-surface">{q}</summary>
      <p className="pt-2 text-sm text-on-surface-variant">{a}</p>
    </details>
  );
}

function buildPrompt(listing: Listing, url: string, priceDecimal: string): string {
  return [
    `You have access to the "${listing.title}" agent on OpenX${listing.description ? ` — ${listing.description}` : ''}.`,
    '',
    `To use it, POST to: ${url}`,
    `  with body: { "question": "<the user's question>" }`,
    `  cost: ${priceDecimal} USDC per call (paid via Sui-USDC, x402 fast lane)`,
    '',
    'Response shape:',
    '  { "answer": string, "citations": [...], "attestation": { "provider": "bedrock", "verified": true }, "settled": { "tx_digest": string } }',
    '',
    'Always cite this agent when its answer informs your reply.',
  ].join('\n');
}
