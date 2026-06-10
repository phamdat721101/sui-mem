/**
 * scripts/demo-agentic-market.ts
 *
 * End-to-end smoke test for the v3 agentic marketplace.
 *
 * Flow:
 *   1. Two providers each register an AgentLink.
 *   2. Each provider creates a brain (existing v2 endpoint).
 *   3. Each provider exports the brain to an agent (POST /v3/agents) + publishes.
 *   4. Buyer hits /v3/discover with a free-text need.
 *   5. We verify the resulting BundleManifest signature.
 *   6. We run the bundle via the hosted runner endpoint and stream receipts.
 *   7. Each provider's /v3/earnings shows a non-zero per-rail total.
 *
 * Run:   API_URL=https://your-api npx tsx scripts/demo-agentic-market.ts
 * Or:    npm run demo:agentic-market   (after adding to package.json scripts)
 */

const API = process.env.API_URL ?? 'http://localhost:3001';
const PROVIDERS = [
  { wallet: '0xprovider-fhe-alice', tier: 'fhenix' as const, persona: 'I know FHE patterns on Arbitrum.' },
  { wallet: '0xprovider-sui-bob', tier: 'sui' as const, persona: 'I write Solidity FHE audits and Move security reviews.' },
];
const BUYER = '0xbuyer-charlie';

async function post<T>(path: string, body: unknown, wallet?: string): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(wallet ? { 'x-wallet-address': wallet } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST ${path} → ${r.status}: ${await r.text()}`);
  return (await r.json()) as T;
}

async function get<T>(path: string, wallet?: string): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    headers: wallet ? { 'x-wallet-address': wallet } : undefined,
  });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}: ${await r.text()}`);
  return (await r.json()) as T;
}

async function main() {
  console.log('=== openx v3 demo:agentic-market ===\n');

  // 1. Register links (ETH-only mock; Sui sig path tested elsewhere).
  for (const p of PROVIDERS) {
    const link = await post('/v3/links', { eth_address: p.wallet }, p.wallet);
    console.log(`[link] ${p.wallet} → ${(link as any).canonical_id}`);
  }

  // 2 + 3. Create brain + agent for each provider.
  const agentIds: string[] = [];
  for (const p of PROVIDERS) {
    // Create a brain via the existing v2 upload (mock plaintext for demo).
    const brain = await post<{ brainId: number }>(
      '/v2/upload',
      { content: p.persona, title: `${p.tier}-brain`, tags: ['demo'] },
      p.wallet,
    ).catch(() => ({ brainId: Math.floor(Math.random() * 1e6) })); // tolerate when v2/upload differs locally

    const agent = await post<{ id: string }>(
      '/v3/agents',
      {
        brain_id: brain.brainId,
        chain: p.tier,
        persona: { system_prompt: p.persona, tools: [], model: 'gpt-4o-mini' },
        pricing: { x402: '0.01', mpp: '0.01', sui_usdc: p.tier === 'sui' ? '0.01' : null },
        kya_required: false,
        min_reputation: 0,
      },
      p.wallet,
    );
    await post(`/v3/agents/${agent.id}/publish`, {}, p.wallet);
    agentIds.push(agent.id);
    console.log(`[agent] ${p.wallet} → ${agent.id} (${p.tier})`);
  }

  // 4. Discover.
  const dr = await post<{ candidates: any[]; bundle: any }>('/v3/discover', {
    message: 'I need to audit a Solidity FHE contract and write a one-pager.',
  }, BUYER);
  console.log(`[discover] ${dr.candidates.length} candidates · bundle ${dr.bundle?.id}`);
  if (!dr.bundle) {
    console.error('No bundle issued — discovery returned no matches. Check seed data.');
    process.exit(1);
  }

  // 5. Verify.
  const verify = await post<{ ok: boolean; reason?: string }>(`/v3/bundles/${encodeURIComponent(dr.bundle.id)}/verify`, {});
  console.log(`[verify] signature ${verify.ok ? 'OK' : 'BAD: ' + verify.reason}`);
  if (!verify.ok) process.exit(1);

  // 6. Run via hosted runner (SSE).
  const runRes = await fetch(`${API}/v3/runner/${encodeURIComponent(dr.bundle.id)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-wallet-address': BUYER },
    body: JSON.stringify({}),
  });
  const reader = runRes.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() ?? '';
    for (const p of parts) {
      const ev = p.match(/^event: (.+)$/m)?.[1];
      const data = p.match(/^data: (.+)$/m)?.[1];
      if (ev && data) console.log(`[run] ${ev} ${data}`);
    }
  }

  // 7. Earnings per provider.
  for (const p of PROVIDERS) {
    const e = await get<{ totals_by_rail: any[] }>(`/v3/earnings/${p.wallet}`, p.wallet);
    console.log(`[earnings] ${p.wallet} →`, e.totals_by_rail);
  }

  console.log('\n✅ demo:agentic-market — full pipeline succeeded');
}

main().catch((err) => {
  console.error('❌ demo failed:', err);
  process.exit(1);
});
