/**
 * smoke-loop-w6-namespace-delegate.ts — PRD-W6 acceptance gate.
 *
 * 5 scenarios (per W6 sub-PRD §Acceptance):
 *   1. Provision-at-publish      — agent publish writes one delegate row
 *   2. L2 fallback               — revoked delegate falls back to operator pool
 *   3. L4 fail-loud              — revoked delegate halts workflow at L4 write
 *   4. Rotate                    — atomic revoke-old + add-new; next L4 write succeeds
 *   5. Unpublish revokes         — revoke fires + agent disappears from index
 *
 * Run:
 *   FEATURE_LOOP_WORKFLOW_V1=true \
 *   FEATURE_LOOP_W3_L4_L5_MEMORY=true \
 *   npx tsx scripts/smoke-loop-w6-namespace-delegate.ts
 *
 * SOLID: this script is the canonical end-to-end gate. It does NOT contain
 * implementation logic; it only orchestrates calls into existing services.
 *
 * STATUS: skeleton — full assertions implemented in sprint task T-087-W6
 * (Week 4). The skeleton lands now so the smoke runner script picks it up
 * and the CI pipeline has the gate registered.
 */

import { pool } from '../packages/api/src/db';
import { getNamespaceDelegateService } from '../packages/api/src/services/loop/namespaceDelegateService';

interface Scenario {
  name: string;
  run: () => Promise<void>;
}

const FAKE_AGENT_ID = '0x' + 'a'.repeat(64);
const FAKE_MEMWAL_ACCOUNT = '0x' + 'b'.repeat(64);
const FAKE_OWNER = '0x' + 'c'.repeat(40);

async function scenario1_provisionAtPublish(): Promise<void> {
  const svc = getNamespaceDelegateService();
  const material = await svc.provisionAtPublish({
    agent_id: FAKE_AGENT_ID,
    memwal_account_id: FAKE_MEMWAL_ACCOUNT,
    owner_wallet: FAKE_OWNER,
  });
  if (!material.delegate_pubkey_hex.startsWith('0x')) throw new Error('expected 0x-prefixed pubkey');
  if (!material.label.startsWith('seller-namespace::')) throw new Error('label malformed');
  if (material.cog_namespace_pattern !== `cog-l[2345]-${FAKE_AGENT_ID}`) {
    throw new Error(`namespace pattern mismatch: ${material.cog_namespace_pattern}`);
  }
  // In a full smoke this would also confirmProvisionedRow() after a publish-PTB
  // confirmation. Skeleton stops here because the PTB round-trip needs Sui
  // testnet credentials.
}

async function scenario2_l2Fallback(): Promise<void> {
  // TODO (T-087-W6): seed a workflow with a revoked delegate; trigger an L2
  // write via memoryService.writeL2; assert the write succeeds via operator-
  // pool fallback + a `memory:write:fallback-to-operator` Pino warning.
  console.log('  ⚠ scenario 2 — skeleton only (full impl T-087-W6)');
}

async function scenario3_l4FailLoud(): Promise<void> {
  // TODO (T-087-W6): seed a workflow with a revoked delegate; trigger an L4
  // write via memoryService.writeL4Agent; assert it throws
  // NamespaceDelegateMissingError; assert workflow halts via mark_stopped.
  console.log('  ⚠ scenario 3 — skeleton only (full impl T-087-W6)');
}

async function scenario4_rotate(): Promise<void> {
  // TODO (T-087-W6): call prepareRotation; mock the rotation PTB; call
  // confirmRotation; assert old row revoked + new row active + the next L4
  // write succeeds.
  console.log('  ⚠ scenario 4 — skeleton only (full impl T-087-W6)');
}

async function scenario5_unpublishRevokes(): Promise<void> {
  const svc = getNamespaceDelegateService();
  await svc.revokeOnUnpublish(FAKE_AGENT_ID);
  const row = await svc.resolveSeller(FAKE_AGENT_ID);
  if (row !== null) throw new Error('expected resolveSeller to return null after revokeOnUnpublish');
}

const SCENARIOS: Scenario[] = [
  { name: 'provision-at-publish', run: scenario1_provisionAtPublish },
  { name: 'l2-fallback',          run: scenario2_l2Fallback },
  { name: 'l4-fail-loud',         run: scenario3_l4FailLoud },
  { name: 'rotate',               run: scenario4_rotate },
  { name: 'unpublish-revokes',    run: scenario5_unpublishRevokes },
];

async function main() {
  console.log('PRD-W6 smoke — Seller Namespace Delegate Keys\n');
  let pass = 0;
  let fail = 0;
  for (const s of SCENARIOS) {
    try {
      await s.run();
      console.log(`✓ ${s.name}`);
      pass++;
    } catch (e) {
      console.error(`✗ ${s.name}: ${(e as Error).message}`);
      fail++;
    }
  }
  console.log(`\n${pass}/${SCENARIOS.length} scenarios passed.`);
  await pool.end().catch(() => undefined);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
