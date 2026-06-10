#!/usr/bin/env -S npx tsx
/**
 * smoke-x402.ts — end-to-end smoke for /api/v1 paid endpoints.
 *
 * Steps:
 *   1. Pick a published agent with a slug from /v3/agents.
 *   2. Fetch its /api/v1/<slug>/.well-known/agent.json — must be parseable.
 *   3. GET /api/v1/<slug>?q=hello — must return 402 with WWW-Authenticate.
 *   4. (optional) If X402_BUYER_PRIVATE_KEY is set, run fetchWithPayment via
 *      n-payment to settle a real payment. Otherwise, document the cURL.
 *
 * Run:  npm run smoke:x402
 *       X402_BUYER_PRIVATE_KEY=0x... npm run smoke:x402   # also settles
 */

const API = process.env.API_URL ?? 'http://localhost:3001';
const buyerKey = process.env.X402_BUYER_PRIVATE_KEY;

interface AgentRow {
  id: string;
  slug?: string | null;
  pricing?: { x402?: string | null };
  brain_id: number;
  owner_address: string;
}

async function main() {
  console.log('[smoke] API =', API);

  // 1. Find a slug.
  const r = await fetch(`${API}/v3/agents`).catch(() => null);
  if (!r?.ok) throw new Error(`/v3/agents HTTP ${r?.status ?? '???'}`);
  const agents = (await r.json()) as AgentRow[];
  const candidate = agents.find((a) => !!a.slug);
  if (!candidate) {
    console.log('[smoke] no published agent with a slug — run the publish wizard first.');
    process.exit(0);
  }
  const slug = candidate.slug as string;
  console.log(`[smoke] target slug = ${slug}  owner = ${candidate.owner_address}`);

  // 2. agent.json check.
  const cardRes = await fetch(`${API}/api/v1/${slug}/.well-known/agent.json`);
  if (!cardRes.ok) throw new Error(`agent.json HTTP ${cardRes.status}`);
  const card = await cardRes.json();
  console.log('[smoke] agent.json:', { name: card.name, payTo: card.payTo, chain: card.chain });

  // 3. Trigger 402.
  const probe = await fetch(`${API}/api/v1/${slug}?q=hello`);
  if (probe.status !== 402) {
    throw new Error(`expected 402, got ${probe.status}`);
  }
  const wwwAuth = probe.headers.get('www-authenticate');
  if (!wwwAuth?.startsWith('Payment')) {
    throw new Error(`missing/invalid WWW-Authenticate: ${wwwAuth}`);
  }
  console.log('[smoke] 402 OK · WWW-Authenticate:', wwwAuth);

  // 4. Optional settlement.
  if (!buyerKey) {
    console.log('\n[smoke] set X402_BUYER_PRIVATE_KEY to settle a real payment. Manual cURL:');
    console.log(`  curl -i ${API}/api/v1/${slug}?q=hello`);
    return;
  }

  // Use n-payment via Function-require so this script doesn't rely on TS types.
  const requireFn = Function('m', 'return require(m)') as (m: string) => any;
  const np = requireFn('n-payment');
  const client = np.createPaymentClient({
    chains: ['arbitrum-sepolia'],
    wallet: { privateKey: buyerKey },
  });
  console.log('[smoke] paying via fetchWithPayment…');
  const settled = await client.fetchWithPayment(`${API}/api/v1/${slug}?q=hello`);
  if (!settled.ok) throw new Error(`paid call HTTP ${settled.status}`);
  const body = await settled.json();
  const txHash = settled.headers?.get?.('X-PAYMENT-RESPONSE') ?? '(unknown)';
  console.log(`[smoke] ✓ paid + answered  tx=${txHash}`);
  console.log('[smoke] answer:', String(body.answer ?? '').slice(0, 200));
}

main().catch((err) => {
  console.error('[smoke] FAIL', err.message);
  process.exit(1);
});
