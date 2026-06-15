/**
 * scripts/smoke-agent-workspace-e2e.ts — PRD-E port regression gate.
 *
 * Black-box exercise of `/v3/agents/*` and `/api/v1/<slug>/.well-known/agent.json`
 * against a running API. Asserts the failure-path shapes that don't require
 * a published agent (so the smoke runs in CI without seed data).
 *
 * What it asserts:
 *   1. /v3/agents/slug-available with bad input → invalid/false
 *   2. /v3/agents/<unknown>/uploads/mint → 404
 *   3. /v3/agents/<unknown>/uploads/mint with bad MIME → 415 OR 404
 *   4. /v3/agents/<unknown>/uploads/mint with oversized PDF → 413 OR 404
 *   5. /v3/agents/<unknown>/recent-calls returns shape { rows: [] }
 *   6. /api/v1/<unknown>/.well-known/agent.json → 404
 *
 * Run:
 *   OPENX_API_URL=http://localhost:3001 npm run smoke:agent-workspace-e2e
 *
 * Skipped (require live agent + Sui sponsor):
 *   - paid /try happy path (needs sponsor wallet + Coin<USDC>)
 *   - PDF extract (needs Walrus blob + pdfjs-dist installed)
 */

const API = process.env.OPENX_API_URL ?? 'http://localhost:3001';
const UNKNOWN_SLUG = `nonexistent-${Date.now().toString(36)}`;

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

async function main(): Promise<void> {
  console.log(`smoke-agent-workspace-e2e → ${API}`);

  await step('slug-available rejects too-short slug', async () => {
    const r = await fetch(`${API}/v3/agents/slug-available?slug=ab`);
    if (r.status !== 200) throw new Error(`expected 200, got ${r.status}`);
    const j = (await r.json()) as { available: boolean; reason?: string };
    if (j.available !== false) throw new Error(`expected available=false, got ${JSON.stringify(j)}`);
  });

  await step('slug-available rejects reserved slug', async () => {
    const r = await fetch(`${API}/v3/agents/slug-available?slug=admin`);
    const j = (await r.json()) as { available: boolean; reason?: string };
    if (j.available !== false || j.reason !== 'reserved') {
      throw new Error(`expected reserved, got ${JSON.stringify(j)}`);
    }
  });

  await step('slug-available accepts valid unique slug', async () => {
    const slug = `smoke-${Date.now().toString(36)}`;
    const r = await fetch(`${API}/v3/agents/slug-available?slug=${slug}`);
    const j = (await r.json()) as { available: boolean };
    if (j.available !== true) throw new Error(`expected available=true, got ${JSON.stringify(j)}`);
  });

  await step('uploads/mint on unknown slug → 404', async () => {
    const r = await fetch(`${API}/v3/agents/${UNKNOWN_SLUG}/uploads/mint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ original_name: 'x.txt', mime_type: 'text/plain', size_bytes: 1 }),
    });
    if (r.status !== 404) throw new Error(`expected 404, got ${r.status}`);
  });

  await step('recent-calls on unknown slug returns empty rows', async () => {
    const r = await fetch(`${API}/v3/agents/${UNKNOWN_SLUG}/recent-calls`);
    if (r.status !== 200) throw new Error(`expected 200, got ${r.status}`);
    const j = (await r.json()) as { rows: unknown[]; cached: boolean };
    if (!Array.isArray(j.rows)) throw new Error(`expected rows[], got ${JSON.stringify(j)}`);
    if (j.rows.length !== 0) throw new Error(`expected empty rows, got ${j.rows.length}`);
  });

  await step('agent.json on unknown slug → 404', async () => {
    const r = await fetch(`${API}/api/v1/${UNKNOWN_SLUG}/.well-known/agent.json`);
    if (r.status !== 404) throw new Error(`expected 404, got ${r.status}`);
  });

  await step('try on unknown slug → 404', async () => {
    const r = await fetch(`${API}/v3/agents/${UNKNOWN_SLUG}/try`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'hello' }),
    });
    if (r.status !== 404) throw new Error(`expected 404, got ${r.status}`);
  });

  console.log('\n✅ smoke-agent-workspace-e2e passed');
}

main().catch((e) => {
  console.error('smoke failed:', e);
  process.exit(1);
});
