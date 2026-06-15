/**
 * scripts/backfill-loop-agents-to-memwal.ts
 *
 * Reads `LoopAgentPublished` events from Sui chain history and re-indexes
 * each agent into the `openx-loop-agent-index` MemWal namespace. One-shot;
 * idempotent (MemWal recall dedupes by text similarity, but the loop tags
 * agent_object_id in the JSON tail so duplicates are recoverable).
 *
 * Usage:
 *   npm run backfill:loop-agents
 *
 * Required env:
 *   OPENX_BRAIN_PACKAGE_ID    — the deployed Move package id
 *   SUI_RPC_URL               — fullnode URL
 *   MEMWAL_PEERDEP_ENABLED=true
 *   OPENX_MEMWAL_ACCOUNT_ID + OPENX_MEMWAL_DELEGATE_PRIVATE_KEYS
 *
 * Per the project rule: NO new postgres tables — this script is the only
 * way to populate MemWal from chain history.
 */

import 'dotenv/config';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { indexLoopAgent } from '../packages/api/src/services/loop/conciergeService';

async function main() {
  const PACKAGE_ID = process.env.OPENX_BRAIN_PACKAGE_ID;
  if (!PACKAGE_ID) throw new Error('OPENX_BRAIN_PACKAGE_ID required');
  const client = new SuiClient({ url: process.env.SUI_RPC_URL ?? getFullnodeUrl('testnet') });

  const eventType = `${PACKAGE_ID}::openx_loop_agent_registry::LoopAgentPublished`;
  let cursor: { txDigest: string; eventSeq: string } | null | undefined = null;
  let total = 0;

  do {
    const r: { data: Array<{ parsedJson?: unknown }>; hasNextPage: boolean; nextCursor: typeof cursor } = await client.queryEvents({
      query: { MoveEventType: eventType },
      cursor: cursor ?? null,
      limit: 50,
      order: 'ascending',
    });
    for (const ev of r.data) {
      const j = (ev.parsedJson ?? {}) as Record<string, unknown>;
      const agent_object_id = String(j.id ?? '');
      if (!agent_object_id) continue;
      await indexLoopAgent({
        agent_object_id,
        seller: String(j.seller ?? ''),
        title: 'Loop Agent (backfilled)',
        short_description: '',
        persona_summary: '',
        tags: [],
        per_iter_default_micro_usdc: String(j.per_iter_default_micro_usdc ?? '0'),
        max_iter_per_job: Number(j.max_iter_per_job ?? 0),
        manifest_walrus_blob_id: String(j.manifest_walrus_blob_id ?? ''),
      });
      total += 1;
    }
    cursor = r.hasNextPage ? r.nextCursor : null;
  } while (cursor);

  // eslint-disable-next-line no-console
  console.log(`backfill-loop-agents: indexed ${total} agents`);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
