'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useCurrentAccount } from '@mysten/dapp-kit';
import { api, type EditableAgent, type AgentPaymentInfo } from '@/lib/api';

/**
 * /studio/agent/[slug]/config — per-agent post-publish editor.
 *
 *   Owner-gate: the GET endpoint is owner-only; a 404 (== "not yours")
 *   renders 403. PATCH writes any subset of the 10 editable fields.
 *
 *   Includes a "Buyer onboarding" card with two tabs (Human / Agent) so
 *   the seller can copy-paste the right setup into a buyer's agent host.
 *
 * SOLID:
 *   - SRP: render + dispatch. Validation lives on the server.
 *   - DIP: every wire shape comes from lib/api types.
 */

const DOMAIN_OPTIONS = ['marketing', 'finance', 'research', 'engineering', 'generalist', 'other'] as const;
const TIER_OPTIONS = ['basic', 'verified', 'tee_attested'] as const;

export default function AgentConfigPage() {
  const account = useCurrentAccount();
  const params = useParams<{ slug: string }>();
  const slug = params?.slug ?? '';
  if (!account) return <ConnectGate />;
  if (!slug) return null;
  return <ConfigContent wallet={account.address} slug={slug} />;
}

function ConfigContent({ wallet, slug }: { wallet: string; slug: string }) {
  const [agent, setAgent] = useState<EditableAgent | null>(null);
  const [paymentInfo, setPaymentInfo] = useState<AgentPaymentInfo | null>(null);
  const [notOwner, setNotOwner] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Form state — single source of truth, drift-checked against `agent`.
  const [title, setTitle] = useState('');
  const [shortDesc, setShortDesc] = useState('');
  const [longDesc, setLongDesc] = useState('');
  const [domain, setDomain] = useState<string>('generalist');
  const [tier, setTier] = useState<string>('basic');
  const [tagsCsv, setTagsCsv] = useState('');
  const [persona, setPersona] = useState('');
  const [toolsCsv, setToolsCsv] = useState('');
  const [priceSuiUsdc, setPriceSuiUsdc] = useState('');
  const [priceX402, setPriceX402] = useState('');
  const [priceMpp, setPriceMpp] = useState('');
  const [freeCap, setFreeCap] = useState<string>('');  // string so empty = "use default"

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const a = await api.getOwnedAgent(wallet, slug);
      if (!a) {
        setNotOwner(true);
        return;
      }
      setAgent(a);
      setTitle(a.title ?? '');
      setShortDesc(a.short_description ?? '');
      setLongDesc(a.long_description ?? '');
      setDomain(a.domain ?? 'generalist');
      setTier(a.verification_tier ?? 'basic');
      setTagsCsv((a.tags ?? []).join(', '));
      setPersona(a.persona?.system_prompt ?? '');
      setToolsCsv((a.persona?.tools ?? []).join(', '));
      setPriceSuiUsdc(a.pricing?.sui_usdc ?? '');
      setPriceX402(a.pricing?.x402 ?? '');
      setPriceMpp(a.pricing?.mpp ?? '');
      setFreeCap(a.daily_request_cap !== null && a.daily_request_cap !== undefined ? String(a.daily_request_cap) : '');
      const info = await api.agentPaymentInfo(slug);
      setPaymentInfo(info);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [wallet, slug]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const dirty = useMemo(() => {
    if (!agent) return false;
    const cleanTags = tagsCsv.split(',').map((t) => t.trim()).filter(Boolean);
    const cleanTools = toolsCsv.split(',').map((t) => t.trim()).filter(Boolean);
    const currentFreeCap = agent.daily_request_cap !== null && agent.daily_request_cap !== undefined ? String(agent.daily_request_cap) : '';
    return (
      title !== (agent.title ?? '') ||
      shortDesc !== (agent.short_description ?? '') ||
      longDesc !== (agent.long_description ?? '') ||
      domain !== (agent.domain ?? 'generalist') ||
      tier !== (agent.verification_tier ?? 'basic') ||
      JSON.stringify(cleanTags) !== JSON.stringify(agent.tags ?? []) ||
      persona !== (agent.persona?.system_prompt ?? '') ||
      JSON.stringify(cleanTools) !== JSON.stringify(agent.persona?.tools ?? []) ||
      priceSuiUsdc !== (agent.pricing?.sui_usdc ?? '') ||
      priceX402 !== (agent.pricing?.x402 ?? '') ||
      priceMpp !== (agent.pricing?.mpp ?? '') ||
      freeCap !== currentFreeCap
    );
  }, [agent, title, shortDesc, longDesc, domain, tier, tagsCsv, persona, toolsCsv, priceSuiUsdc, priceX402, priceMpp, freeCap]);

  const onSave = async () => {
    if (!agent || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      const cleanTags = tagsCsv.split(',').map((t) => t.trim()).filter(Boolean);
      const cleanTools = toolsCsv.split(',').map((t) => t.trim()).filter(Boolean);
      const patch: Parameters<typeof api.updateAgent>[2] = {};
      if (title !== (agent.title ?? '')) patch.title = title;
      if (shortDesc !== (agent.short_description ?? '')) patch.short_description = shortDesc;
      if (longDesc !== (agent.long_description ?? '')) patch.long_description = longDesc || null;
      if (domain !== (agent.domain ?? 'generalist')) patch.domain = domain as Parameters<typeof api.updateAgent>[2]['domain'];
      if (tier !== (agent.verification_tier ?? 'basic')) patch.verification_tier = tier as 'basic';
      if (JSON.stringify(cleanTags) !== JSON.stringify(agent.tags ?? [])) patch.tags = cleanTags;
      if (persona !== (agent.persona?.system_prompt ?? '') || JSON.stringify(cleanTools) !== JSON.stringify(agent.persona?.tools ?? [])) {
        patch.persona = { system_prompt: persona, tools: cleanTools };
      }
      const pricing: Record<string, string | null> = {};
      if (priceSuiUsdc !== (agent.pricing?.sui_usdc ?? '')) pricing.sui_usdc = priceSuiUsdc || null;
      if (priceX402     !== (agent.pricing?.x402     ?? '')) pricing.x402     = priceX402     || null;
      if (priceMpp      !== (agent.pricing?.mpp      ?? '')) pricing.mpp      = priceMpp      || null;
      if (Object.keys(pricing).length > 0) patch.pricing = pricing;
      const currentFreeCap = agent.daily_request_cap !== null && agent.daily_request_cap !== undefined ? String(agent.daily_request_cap) : '';
      if (freeCap !== currentFreeCap) {
        patch.daily_request_cap = freeCap === '' ? null : Number(freeCap);
      }

      const r = await api.updateAgent(wallet, slug, patch);
      setAgent(r.agent);
      setSavedAt(Date.now());
      const info = await api.agentPaymentInfo(slug);
      setPaymentInfo(info);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (notOwner) {
    return (
      <div className="mx-auto max-w-xl rounded-xl border border-error/30 bg-error/10 p-12 text-center">
        <span className="material-symbols-outlined text-[36px] text-error">block</span>
        <h1 className="mt-2 font-headline text-2xl font-bold">Not your agent</h1>
        <p className="mt-2 text-sm text-on-surface-variant">Only the agent owner can edit config.</p>
        <Link href="/studio" className="mt-4 inline-block text-primary underline">Back to studio</Link>
      </div>
    );
  }
  if (!agent) {
    return <div className="mx-auto max-w-xl p-8 text-center text-on-surface-variant">Loading…</div>;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="font-headline text-3xl font-bold">Agent Config</h1>
          <p className="text-sm text-on-surface-variant">slug: <span className="font-mono">{slug}</span></p>
        </div>
        <div className="flex gap-2 text-sm">
          <Link href={`/studio/agent/${slug}/train`} className="rounded border border-outline-variant px-3 py-1.5 hover:bg-surface-variant">Train</Link>
          <Link href={`/agent/${slug}`} className="rounded border border-outline-variant px-3 py-1.5 hover:bg-surface-variant" target="_blank">View public</Link>
        </div>
      </header>

      {error && <div className="rounded border border-error/30 bg-error/10 p-3 text-sm text-error">{error}</div>}
      {savedAt && Date.now() - savedAt < 4000 && (
        <div className="rounded border border-success/30 bg-success/10 p-3 text-sm text-success">Saved · pricing takes effect on the next paid call.</div>
      )}

      {/* ─── Identity ─── */}
      <Section title="Identity">
        <Field label="Title (3..120 chars)">
          <input className={inputCx} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Domain">
            <select className={inputCx} value={domain} onChange={(e) => setDomain(e.target.value)}>
              {DOMAIN_OPTIONS.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </Field>
          <Field label="Verification tier">
            <select className={inputCx} value={tier} onChange={(e) => setTier(e.target.value)}>
              {TIER_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
        </div>
        {tier !== 'basic' && (
          <p className="text-xs text-warning">
            Note: <code>{tier}</code> badge is self-set on testnet. Mainnet will require admin attestation.
          </p>
        )}
      </Section>

      {/* ─── Description ─── */}
      <Section title="Description">
        <Field label="Short description (10..240 chars)">
          <textarea className={textareaCx} value={shortDesc} onChange={(e) => setShortDesc(e.target.value)} rows={2} maxLength={240} />
          <span className="text-xs text-on-surface-variant">{shortDesc.length} / 240</span>
        </Field>
        <Field label="Long description (≤4000 chars, optional)">
          <textarea className={textareaCx} value={longDesc} onChange={(e) => setLongDesc(e.target.value)} rows={4} maxLength={4000} />
        </Field>
        <Field label="Tags (comma-separated, ≤10)">
          <input className={inputCx} value={tagsCsv} onChange={(e) => setTagsCsv(e.target.value)} placeholder="sui, web3, research" />
        </Field>
      </Section>

      {/* ─── Persona ─── */}
      <Section title="Persona">
        <Field label="System prompt (≥10 chars)">
          <textarea className={textareaCx} value={persona} onChange={(e) => setPersona(e.target.value)} rows={6} />
        </Field>
        <Field label="Tools (comma-separated, optional)">
          <input className={inputCx} value={toolsCsv} onChange={(e) => setToolsCsv(e.target.value)} placeholder="web_search, code_eval" />
        </Field>
      </Section>

      {/* ─── Pricing ─── */}
      <Section title="Pricing">
        <p className="text-xs text-on-surface-variant">
          Per-call price in USDC. Leave a rail blank to disable that payment method.
          Sui-USDC is the canonical settlement rail; x402 + mpp are aggregator-compatible mirrors.
        </p>
        <div className="grid grid-cols-3 gap-3">
          <Field label="sui_usdc (recommended)">
            <input className={inputCx} value={priceSuiUsdc} onChange={(e) => setPriceSuiUsdc(e.target.value)} placeholder="0.05" inputMode="decimal" />
          </Field>
          <Field label="x402">
            <input className={inputCx} value={priceX402} onChange={(e) => setPriceX402(e.target.value)} placeholder="0.05" inputMode="decimal" />
          </Field>
          <Field label="mpp">
            <input className={inputCx} value={priceMpp} onChange={(e) => setPriceMpp(e.target.value)} placeholder="0.05" inputMode="decimal" />
          </Field>
        </div>
        <Field label="Free turns per buyer per day (0..10000)">
          <input
            className={inputCx}
            value={freeCap}
            onChange={(e) => setFreeCap(e.target.value.replace(/[^0-9]/g, ''))}
            placeholder="5"
            inputMode="numeric"
          />
          <span className="text-xs text-on-surface-variant">
            After this many free /try calls in a 24h rolling window per buyer (IP), the paywall fires (HTTP 429 → frontend prompts wallet sign).
            Leave blank to use the platform default ({process.env.NEXT_PUBLIC_FREE_DAILY_CAP_DEFAULT ?? '5'}). Counted from the persistent paid_calls ledger,
            so a server restart does NOT reset the count.
          </span>
        </Field>
      </Section>

      <div className="flex items-center gap-3 pt-2">
        <button
          onClick={onSave}
          disabled={!dirty || saving}
          className="rounded-full bg-primary px-6 py-2.5 font-medium text-on-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? 'Saving…' : dirty ? 'Save changes' : 'Up to date'}
        </button>
        <button onClick={() => void refresh()} className="text-sm text-on-surface-variant underline" disabled={saving}>Discard changes</button>
      </div>

      {/* ─── Buyer Onboarding ─── */}
      <BuyerOnboarding paymentInfo={paymentInfo} slug={slug} />
    </div>
  );
}

// ─── Buyer Onboarding panel ─────────────────────────────────────────

function BuyerOnboarding({ paymentInfo, slug }: { paymentInfo: AgentPaymentInfo | null; slug: string }) {
  const [tab, setTab] = useState<'human' | 'agent'>('human');
  const [paywallProbe, setPaywallProbe] = useState<{ status: number; body: unknown } | null>(null);

  const probe = async () => {
    if (!paymentInfo) return;
    try {
      const r = await fetch(paymentInfo.public_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'paywall probe — what do you charge?' }),
        cache: 'no-store',
      });
      const body = await r.json().catch(() => ({}));
      setPaywallProbe({ status: r.status, body });
    } catch (e) {
      setPaywallProbe({ status: 0, body: { error: (e as Error).message } });
    }
  };

  if (!paymentInfo) {
    return (
      <Section title="Buyer onboarding">
        <p className="text-sm text-on-surface-variant">
          Save the form first — the public URL appears once the agent is published with a price.
        </p>
      </Section>
    );
  }

  const mcpJson = JSON.stringify(
    {
      mcpServers: {
        openx: {
          command: 'npx',
          args: ['-y', '@openx/mcp'],
          env: {
            OPENX_API_URL: paymentInfo.public_url.replace(/\/api\/v1\/.*$/, ''),
            OPENX_WALLET_ADDRESS: '0xYOUR_AGENT_SUI_ADDRESS',
            OPENX_WALLET_PRIVATE_KEY: 'suiprivkey1...   # testnet only; use a KMS for mainnet',
          },
        },
      },
    },
    null,
    2,
  );

  const agentSystemPrompt = [
    `You are an autonomous agent on OpenX, a Sui-native paid agent marketplace.`,
    ``,
    `Wallet (set by your host runtime via env):`,
    `  • Your Sui address:  $OPENX_WALLET_ADDRESS`,
    `  • Settlement asset:   USDC on Sui`,
    `  • Asset coin type:    ${paymentInfo.asset_coin_type ?? '<unset>'}`,
    `  • Network:            sui-${paymentInfo.network}`,
    ``,
    `Before any paid call, ensure your USDC balance covers the price advertised at`,
    `${paymentInfo.public_url.replace(/\/api\/v1\/.*$/, '/v3/marketplace/agents/<slug>/payment-info')}.`,
    ``,
    `Payment flow when you receive HTTP 402 Payment Required:`,
    `  1. Read x-payment-rail and the body.required.amount fields from the 402 response.`,
    `  2. Build a Sui PTB transferring the required USDC to body.required.payee.`,
    `  3. Sign the PTB with $OPENX_WALLET_PRIVATE_KEY.`,
    `  4. Submit the tx, wait for confirmation, and read the digest.`,
    `  5. Retry the original request with header  x-payment: <digest>`,
    ``,
    `If you use the OpenX MCP server, the runtime handles steps 1-5 automatically; just`,
    `call the paid tool as normal and the host pays + retries on your behalf.`,
  ].join('\n');

  return (
    <Section title="Buyer onboarding">
      <div className="flex gap-2 border-b border-outline-variant pb-2">
        <button
          onClick={() => setTab('human')}
          className={`rounded px-3 py-1.5 text-sm ${tab === 'human' ? 'bg-primary text-on-primary' : 'text-on-surface-variant'}`}
        >Human buyer</button>
        <button
          onClick={() => setTab('agent')}
          className={`rounded px-3 py-1.5 text-sm ${tab === 'agent' ? 'bg-primary text-on-primary' : 'text-on-surface-variant'}`}
        >Agent buyer (machine)</button>
      </div>

      {tab === 'human' && (
        <div className="space-y-3 text-sm">
          <p>
            Human buyers visit the public URL, click <b>Try</b>, and a wallet popup (Slush / Suiet / OKX-Sui)
            asks them to sign the USDC transfer. After confirmation they get the answer.
          </p>
          <KeyValue k="Public URL" v={<a href={paymentInfo.public_url} target="_blank" className="underline text-primary">{paymentInfo.public_url}</a>} />
          <KeyValue k="Price per call" v={paymentInfo.price_usdc ? `${paymentInfo.price_usdc} USDC` : <em className="text-warning">no rail set — set one above</em>} />
          <KeyValue k="Payee (your wallet)" v={<span className="font-mono text-xs break-all">{paymentInfo.payee_address}</span>} />
          <KeyValue k="USDC coin type" v={<span className="font-mono text-xs break-all">{paymentInfo.asset_coin_type ?? '— OPENX_USDC_COIN_TYPE not set —'}</span>} />
          <div className="pt-2">
            <button onClick={probe} className="rounded border border-outline-variant px-3 py-1.5 text-xs hover:bg-surface-variant">
              Test paywall (curl public URL)
            </button>
            {paywallProbe && (
              <pre className="mt-2 max-h-48 overflow-auto rounded bg-surface-variant p-3 text-xs">
{`HTTP ${paywallProbe.status}
${JSON.stringify(paywallProbe.body, null, 2)}`}
              </pre>
            )}
          </div>
        </div>
      )}

      {tab === 'agent' && (
        <div className="space-y-3 text-sm">
          <p>
            Agent buyers (Claude Desktop, Cursor, AgentCore, autonomous workers) need
            <b> a Sui wallet with USDC balance</b>. Drop these into your MCP host:
          </p>
          <div>
            <p className="font-medium">1) MCP server config (<code>~/.claude/mcp.json</code> or equivalent):</p>
            <pre className="mt-1 max-h-72 overflow-auto rounded bg-surface-variant p-3 text-xs font-mono">{mcpJson}</pre>
          </div>
          <div>
            <p className="font-medium">2) Recommended system prompt (paste into your agent):</p>
            <pre className="mt-1 max-h-72 overflow-auto rounded bg-surface-variant p-3 text-xs whitespace-pre-wrap">{agentSystemPrompt}</pre>
          </div>
          <KeyValue
            k="Payment-info endpoint"
            v={<a target="_blank" className="underline text-primary text-xs break-all" href={`${paymentInfo.public_url.replace(/\/api\/v1\/.*$/, '')}/v3/marketplace/agents/${slug}/payment-info`}>
              {`/v3/marketplace/agents/${slug}/payment-info`}
            </a>}
          />
        </div>
      )}
    </Section>
  );
}

// ─── primitives ─────────────────────────────────────────────────────

const inputCx    = 'w-full rounded border border-outline-variant bg-transparent px-3 py-2 text-sm focus:border-primary focus:outline-none';
const textareaCx = 'w-full rounded border border-outline-variant bg-transparent px-3 py-2 text-sm focus:border-primary focus:outline-none';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-xl border border-outline-variant bg-surface p-5">
      <h2 className="font-headline text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium uppercase tracking-wide text-on-surface-variant">{label}</span>
      {children}
    </label>
  );
}
function KeyValue({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 border-b border-outline-variant/40 pb-1">
      <span className="w-40 shrink-0 text-xs uppercase tracking-wide text-on-surface-variant">{k}</span>
      <span className="text-sm">{v}</span>
    </div>
  );
}
function ConnectGate() {
  return (
    <div className="mx-auto max-w-xl p-12 text-center">
      <p className="text-sm text-on-surface-variant">Connect a Sui wallet to edit your agent.</p>
    </div>
  );
}
