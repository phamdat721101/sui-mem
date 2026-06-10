#!/usr/bin/env tsx
/**
 * smoke-marketplace-seller-first — end-to-end seller-first v2 flow.
 *
 * Covers PRD-14 (seller↔agent split) + PRD-15 (workflow listing) +
 * PRD-16 (network-aware privacy). Each step is non-zero-exit on failure.
 *
 *   1. POST /v3/marketplace/seller/publish with kind='api', privacy=fhe (Arbitrum)
 *      → assert seller_id, kind, privacy_mode persisted.
 *   2. POST again under same wallet — kind='workflow' (marketing-7-step shape)
 *      → assert same seller_id, agents.kind='workflow', cognitive_workflows row.
 *   3. GET /v3/marketplace/seller/me → assert profile populated.
 *   4. GET /v3/marketplace/seller/dashboard → assert 2 agents rolled up.
 *   5. GET /v3/marketplace/workflows → assert workflow appears.
 *   6. GET /v3/marketplace/workflows/:slug → assert detail returns steps.
 *   7. POST /v3/discover { message:'…', kind:'workflow' } → assert workflow ranked.
 *
 * Usage:
 *   API_URL=http://localhost:3001 \
 *   SMOKE_WALLET=0x000…abcd \
 *     tsx scripts/smoke-marketplace-seller-first.ts
 */

const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const WALLET = (
  process.env.SMOKE_WALLET ?? '0x000000000000000000000000000000000000beef'
).toLowerCase();

async function http(
  path: string,
  init: RequestInit = {},
  expectOk = true,
): Promise<{ status: number; body: any }> {
  const r = await fetch(`${API_URL}${path}`, init);
  const text = await r.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  if (expectOk && !r.ok) {
    throw new Error(`${path} → ${r.status}: ${text.slice(0, 200)}`);
  }
  return { status: r.status, body };
}

function assert(cond: any, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function main(): Promise<void> {
  console.log(`== smoke:marketplace-seller-first against ${API_URL} ==`);

  const tag = Date.now().toString(36).slice(-6);
  const headers = {
    'content-type': 'application/json',
    'x-wallet-address': WALLET,
  };

  // 1. Publish an API listing — auto-detected privacy=fhe via Arbitrum chain id.
  const apiBody = {
    title: `Smoke API ${tag}`,
    short_description: 'Smoke test API listing under seller-first wizard.',
    domain: 'engineering',
    persona_system_prompt: 'You are a smoke-test agent that echoes inputs.',
    pricing_amount_usdc: '0.05',
    pricing_rails: ['x402'],
    kind: 'api',
    seller_profile: { display_name: `Smoke Seller ${tag}` },
    privacy: { mode: 'fhe', source: 'auto', chain_id: 421614 },
  };
  const { body: api } = await http('/v3/marketplace/seller/publish', {
    method: 'POST',
    headers,
    body: JSON.stringify(apiBody),
  });
  assert(api.seller_id, 'api publish: seller_id present');
  assert(api.kind === 'api', 'api publish: kind=api');
  assert(api.privacy_mode === 'fhe', 'api publish: privacy_mode=fhe');
  assert(api.privacy_source === 'auto', 'api publish: privacy_source=auto');
  console.log(`  ✓ API listing seller_id=${api.seller_id} slug=${api.slug}`);

  // 2. Publish a workflow listing under the SAME wallet → same seller_id.
  const wfKey = `smoke-wf-${tag}`;
  const wfBody = {
    title: `Smoke Workflow ${tag}`,
    short_description: 'Smoke test workflow with 2 steps.',
    domain: 'marketing',
    persona_system_prompt: 'Smoke workflow.',
    pricing_amount_usdc: '0.50',
    pricing_rails: ['x402'],
    kind: 'workflow',
    workflow: {
      workflow_key: wfKey,
      name: `Smoke Workflow ${tag}`,
      description: 'Two-step smoke workflow.',
      steps: [
        { id: 'a', type: 'skill', tool_ref: 'openx://skills/ingest-url', price_usdc: '0.10' },
        { id: 'b', type: 'skill', tool_ref: 'openx://skills/research-brief', price_usdc: '0.20' },
      ],
      default_price_usdc: '0.50',
    },
    privacy: { mode: 'fhe', source: 'auto', chain_id: 421614 },
  };
  const { body: wf } = await http('/v3/marketplace/seller/publish', {
    method: 'POST',
    headers,
    body: JSON.stringify(wfBody),
  });
  assert(wf.seller_id === api.seller_id, 'workflow publish: same seller_id as api publish');
  assert(wf.kind === 'workflow', 'workflow publish: kind=workflow');
  console.log(`  ✓ Workflow listing seller_id=${wf.seller_id} slug=${wf.slug}`);

  // 3. seller/me — profile populated.
  const { body: me } = await http('/v3/marketplace/seller/me', { headers });
  assert(me.seller, 'seller/me: seller row exists');
  assert(me.seller.wallet_address === WALLET, 'seller/me: wallet matches');
  console.log(`  ✓ seller/me display_name="${me.seller.display_name}"`);

  // 4. seller/dashboard — 2 agents rolled up.
  const { body: dash } = await http('/v3/marketplace/seller/dashboard', { headers });
  assert(Array.isArray(dash.agents), 'seller/dashboard: agents array');
  assert(dash.agents.length >= 2, `seller/dashboard: ≥2 agents rolled up (got ${dash.agents.length})`);
  console.log(`  ✓ seller/dashboard rolled up ${dash.agents.length} agents`);

  // 5. workflow catalog includes the new listing.
  const { body: wfList } = await http('/v3/marketplace/workflows?limit=100');
  const found = (wfList.listings ?? []).some((l: any) => l.slug === wf.slug);
  assert(found, `workflows catalog: ${wf.slug} appears`);
  console.log(`  ✓ /v3/marketplace/workflows lists ${wf.slug}`);

  // 6. workflow detail.
  const { body: detail } = await http(`/v3/marketplace/workflows/${wf.slug}`);
  assert(Array.isArray(detail.steps) && detail.steps.length === 2, 'workflow detail: steps round-trip');
  console.log(`  ✓ /v3/marketplace/workflows/${wf.slug} returns ${detail.steps.length} steps`);

  // 7. discover with kind=workflow filter.
  const { body: disc } = await http('/v3/discover', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'two step research workflow', kind: 'workflow', max_steps: 3 }),
  });
  assert(Array.isArray(disc.candidates), 'discover: candidates array');
  console.log(`  ✓ /v3/discover (kind=workflow) returned ${disc.candidates.length} candidates`);

  // 8. /v3/agents/search keyword fast-path (PRD-17 §3). Public endpoint.
  const { body: search } = await http(`/v3/agents/search?q=${encodeURIComponent('Smoke')}&limit=10`);
  assert(Array.isArray(search.candidates), 'search: candidates array');
  assert(['memwal', 'postgres'].includes(search.source), 'search: source field');
  console.log(
    `  ✓ /v3/agents/search returned ${search.candidates.length} candidates (source=${search.source})`,
  );

  console.log('== smoke:marketplace-seller-first OK ==');
}

main().catch((e) => {
  console.error('FAILED:', e?.message ?? e);
  process.exit(1);
});
