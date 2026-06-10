#!/usr/bin/env tsx
/**
 * backfill-agents-to-memwal — one-shot index of every published agent
 * into MemWal namespace `openx-agent-index`. PRD-17 §4.
 *
 * Idempotent: MemWal `remember` upsert is keyed on the [id=<uuid>] prefix
 * we embed in the searchable text, so re-runs replace prior entries.
 *
 * Usage:
 *   MEMWAL_PEERDEP_ENABLED=true \
 *   MEMWAL_OPERATOR_WALLET=… MEMWAL_OPERATOR_ACCOUNT_ID=… \
 *   MEMWAL_OPERATOR_DELEGATE_KEYS=key1,key2 \
 *     npx tsx scripts/backfill-agents-to-memwal.ts
 *
 * No-op (logs and exits 0) when MEMWAL_PEERDEP_ENABLED!=true so the
 * script is safe to wire into CI without Sui secrets.
 */

import { pool } from '../packages/api/src/db';
import { indexAgent } from '../packages/api/src/services/discoveryService';

interface Row {
  agent_id: string;
  slug: string;
  title: string | null;
  short_description: string | null;
  domain: string | null;
  kind: string | null;
  tags: string[] | null;
  persona: { system_prompt?: string | null; tools?: string[] | null } | null;
}

async function main(): Promise<void> {
  if (process.env.MEMWAL_PEERDEP_ENABLED !== 'true') {
    console.log('[backfill] MEMWAL_PEERDEP_ENABLED!=true — no-op exit');
    process.exit(0);
  }

  const r = await pool.query<Row>(
    `SELECT a.id AS agent_id, a.slug, a.domain, a.kind, a.persona,
            a.short_description,
            b.title, b.tags
       FROM agents a
       JOIN brains b ON b.id = a.brain_id
      WHERE a.published = true
   ORDER BY a.created_at ASC`,
  );
  console.log(`[backfill] ${r.rowCount ?? 0} published agents`);
  let ok = 0;
  let failed = 0;
  for (const row of r.rows) {
    try {
      await indexAgent({
        agent_id: row.agent_id,
        slug: row.slug,
        title: row.title ?? '',
        short_description: row.short_description ?? '',
        domain: row.domain ?? '',
        kind: row.kind ?? 'api',
        tags: row.tags ?? [],
        persona_system_prompt: row.persona?.system_prompt ?? '',
      });
      ok += 1;
    } catch (e) {
      failed += 1;
      console.warn('[backfill] failed', row.slug, (e as Error).message);
    }
  }
  console.log(`[backfill] ok=${ok} failed=${failed}`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('[backfill] fatal', e);
  process.exit(1);
});
