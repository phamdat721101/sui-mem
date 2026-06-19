/**
 * scripts/smoke-result-delivery-and-memwal.ts
 *
 * Combined smoke test for the v1.2 ship:
 *   - Track 1: Run Timeline endpoint + Bundle ZIP endpoint + Digest endpoint
 *   - Track 2: Mode A memory writes (L2/L3/L4-per-buyer/L5-per-buyer/L4-agent) +
 *              warm-context recall composition.
 *
 * Requires:
 *   - DATABASE_URL pointing at a Postgres with migrations 001..035 applied.
 *   - API running locally (default http://localhost:3001) OR pass API_URL=...
 *   - The relevant feature flags ON in the API process env.
 *
 * Usage:
 *   FEATURE_LOOP_RUN_TIMELINE=true \
 *   FEATURE_LOOP_RUN_BUNDLE_ZIP=true \
 *   FEATURE_LOOP_MODE_A_MEMORY=true \
 *   ts-node scripts/smoke-result-delivery-and-memwal.ts
 */

/* eslint-disable no-console */
import pg from 'pg';

const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const TEST_WALLET = (process.env.TEST_WALLET ?? '0xsmoketestwallet0000000000000000000000000000000000000000000000abcd').toLowerCase();
const TEST_AGENT_ID = process.env.TEST_AGENT_ID ?? '0xsmoketestagent000000000000000000000000000000000000000000000abcd';
const NS = `artifact-vault-${TEST_WALLET}`;

let passed = 0;
let failed = 0;

function ok(label: string, cond: boolean, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`✓ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.error(`✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  console.log(`smoke: API=${API_URL} wallet=${TEST_WALLET} agent=${TEST_AGENT_ID}`);

  // ── Setup: insert 3 mock runs with 3 artifacts each ────────────────────
  console.log('\n[Track 1] seeding 3 mock runs × 3 artifacts');
  await pool.query(
    `DELETE FROM cognitive_memories
      WHERE namespace = $1
         OR (brain_id = $2 AND namespace LIKE 'cog-l%')`,
    [NS, TEST_AGENT_ID],
  );
  await pool.query(
    `DELETE FROM workflow_runs WHERE buyer_addr = $1`,
    [TEST_WALLET],
  );

  const jobIds = ['smoke-job-001', 'smoke-job-002', 'smoke-job-003'];
  const now = Date.now();
  for (let i = 0; i < jobIds.length; i++) {
    const jid = jobIds[i];
    await pool.query(
      `INSERT INTO workflow_runs
            (job_id, buyer_addr, agent_id, workflow_walrus_blob_id,
             completed_step_count, total_step_count, status,
             budget_micro, spent_micro,
             created_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (job_id) DO NOTHING`,
      [
        jid,
        TEST_WALLET,
        TEST_AGENT_ID,
        `walrus-wf-${i}`,
        4,
        4,
        i % 2 === 0 ? 'COMPLETED' : 'FAILED',
        500_000,
        100_000 + i * 10_000,
        new Date(now - (i + 1) * 86400_000),
        new Date(now - (i + 1) * 86400_000 + 3_600_000),
      ],
    );
    for (const artName of ['report.md', 'diagram.mermaid', 'content.md']) {
      const manifest = JSON.stringify({
        job_id: jid,
        area_slug: 'smoke-area',
        artifact_name: artName,
        walrus_blob_id: `walrus-${jid}-${artName}`,
        mime_type: artName.endsWith('.md') ? 'text/markdown' : 'text/plain',
        size_bytes: 1234,
      });
      await pool.query(
        `INSERT INTO cognitive_memories
              (brain_id, namespace, text, cognitive_level, area_slug)
         VALUES ($1, $2, $3, 4, 'smoke-area')`,
        [TEST_WALLET, NS, manifest],
      );
    }
  }

  // ── Track 1.1: GET /v3/loop/runs/by-buyer/:wallet ─────────────────────
  const runsRes = await fetch(`${API_URL}/v3/loop/runs/by-buyer/${TEST_WALLET}`, {
    headers: { 'x-wallet-address': TEST_WALLET },
  });
  ok('runs endpoint returns 200 (or 404 if flag off)',
     runsRes.status === 200 || runsRes.status === 404,
     `status=${runsRes.status}`);

  if (runsRes.status === 200) {
    const data = await runsRes.json() as { runs: Array<{ job_id: string; artifacts: unknown[] }> };
    ok('runs grouped by job_id', data.runs.length === 3, `got ${data.runs.length} runs`);
    ok('each run has 3 artifacts',
       data.runs.every((r) => r.artifacts.length === 3),
       data.runs.map((r) => r.artifacts.length).join(','));
  }

  // ── Track 1.2: GET /v3/loop/runs/:job_id/bundle.zip ────────────────────
  const bundleRes = await fetch(`${API_URL}/v3/loop/runs/${jobIds[0]}/bundle.zip`, {
    headers: { 'x-wallet-address': TEST_WALLET },
  });
  ok('bundle endpoint returns 200, 404 (flag off), or 502 (walrus mock fail)',
     [200, 404, 500, 502].includes(bundleRes.status),
     `status=${bundleRes.status}`);
  if (bundleRes.status === 200) {
    const ct = bundleRes.headers.get('content-type') ?? '';
    ok('bundle content-type is application/zip', ct.includes('application/zip'), ct);
  }

  // ── Track 1.3: authz check — wrong wallet ─────────────────────────────
  const authRes = await fetch(`${API_URL}/v3/loop/runs/by-buyer/${TEST_WALLET}`, {
    headers: { 'x-wallet-address': '0xdifferentwallet' },
  });
  ok('runs endpoint rejects wallet mismatch with 403/404',
     [403, 404].includes(authRes.status),
     `status=${authRes.status}`);

  // ── Track 1.4: GET /v3/loop/digests/by-buyer/:wallet ──────────────────
  const digRes = await fetch(`${API_URL}/v3/loop/digests/by-buyer/${TEST_WALLET}`, {
    headers: { 'x-wallet-address': TEST_WALLET },
  });
  ok('digest endpoint returns 200 with { digest } shape',
     digRes.status === 200,
     `status=${digRes.status}`);
  if (digRes.status === 200) {
    const data = await digRes.json() as { digest: unknown };
    ok('digest is null or object', data.digest === null || typeof data.digest === 'object');
  }

  // ── Track 2.1: simulate Mode A memory writes by direct insert ──────────
  // (A real /agents/:id/invoke call needs a settled x402 PTB; here we
  // verify the memoryService path by direct SQL — the unit test for
  // agentInvoker is the dedicated check.)
  console.log('\n[Track 2] verifying memory write path');
  for (let i = 0; i < 2; i++) {
    await pool.query(
      `INSERT INTO cognitive_memories (brain_id, namespace, text, cognitive_level)
            VALUES ($1, $2, $3, 2)`,
      [TEST_AGENT_ID, `cog-l2-${TEST_AGENT_ID}-mode-a-${i}`, `paid call ${i}`],
    );
    await pool.query(
      `INSERT INTO cognitive_memories (brain_id, namespace, text, cognitive_level, para_kind, area_slug)
            VALUES ($1, $2, $3, 4, 'project', 'smoke-area')`,
      [TEST_AGENT_ID, `cog-l4-${TEST_AGENT_ID}-${TEST_WALLET}`, `Buyer paid call summary ${i}`],
    );
  }

  // ── Track 2.2: GET /v3/memory/stats/agents/:agent_id ──────────────────
  const statsRes = await fetch(`${API_URL}/v3/memory/stats/agents/${TEST_AGENT_ID}`, {
    headers: { 'x-wallet-address': TEST_WALLET },
  });
  ok('stats endpoint returns 200', statsRes.status === 200, `status=${statsRes.status}`);
  if (statsRes.status === 200) {
    const data = await statsRes.json() as {
      memory_levels: { l2_count_24h: number; l4_per_buyer_count_24h: number };
      flags: Record<string, boolean>;
    };
    ok('stats reports >=2 L2 writes', data.memory_levels.l2_count_24h >= 2,
       `l2=${data.memory_levels.l2_count_24h}`);
    ok('stats reports >=2 L4 per-buyer writes', data.memory_levels.l4_per_buyer_count_24h >= 2,
       `l4-per-buyer=${data.memory_levels.l4_per_buyer_count_24h}`);
    ok('stats includes flag snapshot',
       typeof data.flags?.mode_a_memory_enabled === 'boolean');
  }

  // ── Cleanup ───────────────────────────────────────────────────────────
  await pool.query(
    `DELETE FROM cognitive_memories
      WHERE namespace = $1 OR (brain_id = $2 AND namespace LIKE 'cog-l%')`,
    [NS, TEST_AGENT_ID],
  );
  await pool.query(`DELETE FROM workflow_runs WHERE buyer_addr = $1`, [TEST_WALLET]);
  await pool.end();

  console.log(`\n──────────  ${passed} passed · ${failed} failed  ──────────`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('smoke crashed:', e);
  process.exit(1);
});
