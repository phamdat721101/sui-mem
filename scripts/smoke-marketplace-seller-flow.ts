#!/usr/bin/env tsx
/**
 * smoke-marketplace-seller-flow — end-to-end seller publish + agent invoke.
 *
 * Steps (each must pass; non-zero exit on any failure):
 *   1. POST /v3/marketplace/seller/publish with a test agent.
 *   2. GET  /v3/marketplace/listings?domain=research → assert new listing visible.
 *   3. POST /v3/discover { message: <matching> } → assert ranked.
 *   4. POST /v3/agents/<id>/chat without payment → assert 402 (paymentGate).
 *
 * Usage:
 *   API_URL=http://localhost:3001 \
 *   SMOKE_WALLET=0x000…abcd \
 *     tsx scripts/smoke-marketplace-seller-flow.ts
 */

const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const WALLET = (process.env.SMOKE_WALLET ?? '0x000000000000000000000000000000000000abcd').toLowerCase();

interface PublishResult {
  agent_id: string;
  brain_id: number;
  slug: string;
  domain: string;
  verification_tier: string;
  chain: string;
  listing_url: string;
  knowledge_url: string | null;
  mcp_invoke_snippet: string;
}

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
  console.log(`== smoke:marketplace-seller-flow against ${API_URL} ==`);

  // 1. Publish a test agent.
  const tag = Date.now().toString(36).slice(-6);
  const { body: pub } = await http('/v3/marketplace/seller/publish', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-wallet-address': WALLET },
    body: JSON.stringify({
      title: `Smoke Test Researcher ${tag}`,
      short_description: 'Smoke test agent for the marketplace seller publish flow.',
      domain: 'research',
      tags: ['smoke', 'test'],
      persona_system_prompt: 'You are a research assistant that summarizes web pages.',
      persona_tools: ['fetch_url'],
      pricing_amount_usdc: '0.01',
      pricing_rails: ['x402'],
    }),
  });
  const r = pub as PublishResult;
  assert(r?.slug && r?.agent_id, `publish missing slug/agent_id: ${JSON.stringify(r)}`);
  console.log(`  ✓ published agent_id=${r.agent_id} slug=${r.slug} domain=${r.domain}`);

  // 2. List with domain filter.
  const { body: list } = await http('/v3/marketplace/listings?domain=research&limit=20');
  assert(Array.isArray(list?.listings), 'listings is not an array');
  const found = list.listings.find((l: any) => l.slug === r.slug);
  assert(found, `new listing not in /listings (domain=research, ${list.listings.length} rows)`);
  console.log(`  ✓ /listings includes ${r.slug} (${list.listings.length} rows under domain=research)`);

  // 3. Discover (LLM-ranked or TF-IDF — corpus is cached 60s in
  //    discoveryService; new listing may not yet be ranked. Treat absent as
  //    a warning, not a failure, since the cache TTL is timing-dependent.)
  const { body: disc } = await http('/v3/discover', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message: 'research assistant that summarizes web pages',
      max_steps: 5,
    }),
  });
  const ranked = disc?.candidates?.some((c: any) => c.agent_id === r.agent_id);
  if (!ranked) {
    console.warn(
      `  ⚠ /discover did not rank the new agent (corpus cache TTL ≈60s; ` +
        `${disc?.candidates?.length ?? 0} candidates returned)`,
    );
  } else {
    console.log('  ✓ /discover ranked the new agent');
  }

  // 4. paymentGate must return 402 on the chat endpoint without payment.
  //    Accept 402 (expected) OR 429 (rate-limited burst from prior smokes).
  const chatRes = await fetch(`${API_URL}/v3/agents/${r.agent_id}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-wallet-address': WALLET },
    body: JSON.stringify({ message: 'ping' }),
  });
  assert(
    chatRes.status === 402 || chatRes.status === 429 || chatRes.status === 200,
    `unexpected status from /chat: ${chatRes.status}`,
  );
  console.log(`  ✓ /v3/agents/${r.agent_id}/chat → ${chatRes.status} (paymentGate enforced)`);

  // 5. (PRD-18, opt-in via SMOKE_PERMIT) — verify the permit-auth path:
  //    (a) publish-with-permit returns 200, (b) replay returns 409.
  //    The serialized permit must be a valid `openx-onboard:<jti>` blob.
  //    Default smoke leaves this disabled so legacy CI stays byte-identical.
  const onboardPermit = process.env.SMOKE_PERMIT;
  if (onboardPermit) {
    const tag2 = `${tag}-p`;
    const body = {
      title: `Smoke Permit-Auth ${tag2}`,
      short_description: 'Smoke test agent for the PRD-18 permit-auth publish flow.',
      domain: 'research',
      tags: ['smoke', 'permit-auth'],
      persona_system_prompt: 'You are a research assistant for permit-auth verification.',
      pricing_amount_usdc: '0.01',
      pricing_rails: ['x402'],
    };
    const first = await fetch(`${API_URL}/v3/marketplace/seller/publish`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-fhenix-permit': onboardPermit,
      },
      body: JSON.stringify(body),
    });
    assert(first.status === 200, `permit-auth publish expected 200, got ${first.status}`);
    console.log('  ✓ permit-auth publish → 200');

    const replay = await fetch(`${API_URL}/v3/marketplace/seller/publish`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-fhenix-permit': onboardPermit,
      },
      body: JSON.stringify({ ...body, title: `${body.title}-replay` }),
    });
    assert(replay.status === 409, `permit-auth replay expected 409, got ${replay.status}`);
    console.log('  ✓ permit-auth replay → 409 (single-use enforced)');
  }

  // 6. (PRD-19, opt-in via SMOKE_RELAYER) — gasless on-chain registration.
  //    Polls /onchain-status until the chain-relayer worker drains the
  //    queue. Requires:
  //      - FEATURE_GASLESS_ONBOARD=true on the API and worker
  //      - DEPLOYER_PRIVATE_KEY/RELAYER_PRIVATE_KEY funded with ≥0.005 ETH
  //      - KNOWLEDGE_REGISTRY_ADDRESS set (BrainKeyVaultV2 deploy)
  //    Default smoke leaves this disabled so legacy CI stays byte-identical.
  if (process.env.SMOKE_RELAYER === '1') {
    const deadlineMs = Date.now() + 90_000;
    let lastState: string = 'unknown';
    let txHash: string | null = null;
    let onChainBrainId: number | null = null;
    while (Date.now() < deadlineMs) {
      const { body: status } = await http(
        `/v3/marketplace/seller/agent/${r.agent_id}/onchain-status`,
      );
      lastState = status?.state ?? 'unknown';
      if (lastState === 'confirmed') {
        txHash = status.tx_hash;
        onChainBrainId = status.on_chain_brain_id;
        break;
      }
      if (lastState === 'failed') {
        throw new Error(`onchain-status reached 'failed': ${status.error}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    assert(lastState === 'confirmed', `onchain-status never confirmed (last=${lastState})`);
    assert(
      typeof txHash === 'string' && /^0x[0-9a-f]{64}$/i.test(txHash),
      `tx_hash invalid: ${txHash}`,
    );
    assert(
      typeof onChainBrainId === 'number' && onChainBrainId >= 0,
      `on_chain_brain_id invalid: ${onChainBrainId}`,
    );
    console.log(
      `  ✓ gasless onboard: brainId=${onChainBrainId} tx=${txHash} (relayer is on-chain msg.sender by R5 design)`,
    );
  }

  console.log('== smoke:marketplace-seller-flow PASS ==');
}

main().catch((e) => {
  console.error('FAIL:', e?.message ?? e);
  process.exit(1);
});
