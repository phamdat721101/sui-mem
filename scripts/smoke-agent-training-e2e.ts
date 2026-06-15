/**
 * scripts/smoke-agent-training-e2e.ts — PRD-F gate.
 *
 * Black-box exercises /v3/marketplace/seller/agents/:slug/* against a
 * running API. Asserts the owner-gate posture + the full action flow
 * (upload → remember → reflect → events feed shape).
 *
 * Run:
 *   OPENX_API_URL=http://localhost:3001 \
 *   OWNER_WALLET=0x7b9a... \
 *   AGENT_SLUG=abc \
 *   npm run smoke:agent-training-e2e
 */

const API = process.env.OPENX_API_URL ?? 'http://localhost:3001';
const OWNER = process.env.OWNER_WALLET ?? '';
const SLUG = process.env.AGENT_SLUG ?? '';
const STRANGER = '0x' + 'a'.repeat(64);

async function step(label: string, fn: () => Promise<unknown>): Promise<void> {
  process.stdout.write(`  ${label} … `);
  try {
    await fn();
    process.stdout.write('OK\n');
  } catch (e) {
    process.stdout.write(`FAIL\n    ${(e as Error).message}\n`);
    process.exit(1);
  }
}

function authedFetch(path: string, wallet: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'x-wallet-address': wallet,
      'x-chain': 'sui',
      ...(init.headers ?? {}),
    },
  });
}

async function main(): Promise<void> {
  console.log(`smoke-agent-training-e2e → ${API}`);
  if (!OWNER || !SLUG) {
    console.log('  Skipping live smoke — set OWNER_WALLET + AGENT_SLUG to enable.');
    console.log('  Owner-gate-only check (no auth env required):');

    await step('GET /events on bogus slug → 401 without wallet header', async () => {
      const r = await fetch(`${API}/v3/marketplace/seller/agents/nope/events`);
      if (r.status !== 401) throw new Error(`expected 401, got ${r.status}`);
    });

    await step('GET /events with wallet but bogus slug → 404', async () => {
      const r = await authedFetch('/v3/marketplace/seller/agents/nope/events', STRANGER);
      if (r.status !== 404) throw new Error(`expected 404, got ${r.status}`);
    });

    console.log('\n✅ smoke-agent-training-e2e (owner-gate-only) passed');
    return;
  }

  // Full live flow.
  await step('GET /events as stranger → 404 (owner-gate)', async () => {
    const r = await authedFetch(`/v3/marketplace/seller/agents/${SLUG}/events`, STRANGER);
    if (r.status !== 404) throw new Error(`expected 404, got ${r.status}`);
  });

  await step('GET /events as owner → 200 + array', async () => {
    const r = await authedFetch(`/v3/marketplace/seller/agents/${SLUG}/events`, OWNER);
    if (r.status !== 200) throw new Error(`expected 200, got ${r.status}`);
    const j = (await r.json()) as { events: unknown[] };
    if (!Array.isArray(j.events)) throw new Error('events not an array');
  });

  await step('POST /upload (stranger) → 404', async () => {
    const r = await authedFetch(`/v3/marketplace/seller/agents/${SLUG}/upload`, STRANGER, {
      method: 'POST',
      body: JSON.stringify({
        walrus_blob_id: 'smoke-blob-1', original_name: 'smoke.txt',
        mime_type: 'text/plain', size_bytes: 12,
      }),
    });
    if (r.status !== 404) throw new Error(`expected 404, got ${r.status}`);
  });

  await step('POST /upload (owner) → 201 + id', async () => {
    const r = await authedFetch(`/v3/marketplace/seller/agents/${SLUG}/upload`, OWNER, {
      method: 'POST',
      body: JSON.stringify({
        walrus_blob_id: `smoke-blob-${Date.now().toString(36)}`,
        original_name: 'smoke.txt', mime_type: 'text/plain', size_bytes: 12,
      }),
    });
    if (r.status !== 201) throw new Error(`expected 201, got ${r.status}`);
    const j = (await r.json()) as { id?: string };
    if (!j.id) throw new Error('id missing');
  });

  await step('POST /remember (owner) → 201', async () => {
    const r = await authedFetch(`/v3/marketplace/seller/agents/${SLUG}/remember`, OWNER, {
      method: 'POST',
      body: JSON.stringify({ text: `smoke knowledge ${Date.now()}`, level: 3 }),
    });
    if (r.status !== 201) throw new Error(`expected 201, got ${r.status}`);
    const j = (await r.json()) as { namespace?: string };
    if (!j.namespace?.startsWith('cog-l3-')) throw new Error(`bad namespace: ${j.namespace}`);
  });

  await step('POST /training-loop (owner) → 200 + critique', async () => {
    const r = await authedFetch(`/v3/marketplace/seller/agents/${SLUG}/training-loop`, OWNER, {
      method: 'POST', body: '{}',
    });
    if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${await r.text()}`);
    const j = (await r.json()) as { critique?: string; namespace?: string };
    if (!j.critique || j.critique.length < 10) throw new Error('empty critique');
    if (!j.namespace?.startsWith('cog-l5-')) throw new Error(`bad namespace: ${j.namespace}`);
  });

  await step('GET /events shows the 3 events we just wrote', async () => {
    const r = await authedFetch(`/v3/marketplace/seller/agents/${SLUG}/events?limit=10`, OWNER);
    const j = (await r.json()) as { events: Array<{ event_type: string }> };
    const types = new Set(j.events.map((e) => e.event_type));
    if (!types.has('upload') || !types.has('remember') || !types.has('reflect')) {
      throw new Error(`missing types in ${[...types].join(',')}`);
    }
  });

  console.log('\n✅ smoke-agent-training-e2e passed');
}

main().catch((e) => {
  console.error('smoke failed:', e);
  process.exit(1);
});
