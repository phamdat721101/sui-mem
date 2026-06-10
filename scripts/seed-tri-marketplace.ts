/**
 * seed-tri-marketplace.ts — publish bootstrap content to a live API.
 *
 * Modes:
 *   - LIVE (env API_URL set): POST each brain/skill/workflow to the live API,
 *     prints Sui object ids + Walrus blob ids + dashboard URL.
 *   - DRY (default): validates the bootstrap content (sign, DAG, cost math)
 *     without making network calls. CI runs this. Smoke variant of seed.
 *
 * Required env for LIVE mode:
 *   API_URL                     e.g. https://13-229-63-192.sslip.io
 *   PHAM_WALLET_ADDRESS         0x… seller address
 *   PHAM_PRIVATE_KEY            0x… for signing manifests (test wallet only!)
 *   X_CHAIN=sui                 chain header for requireSuiWallet
 *
 *   npm run seed:tri-marketplace
 */

import { privateKeyToAccount } from 'viem/accounts';
import {
  workflowSigningMessage,
  skillSigningMessage,
  isWorkflowDagValid,
  type Workflow,
  type Skill,
} from '../packages/sdk/src/cognitive/types';
import {
  BOOTSTRAP_BRAINS,
  BOOTSTRAP_SKILLS,
  MARKETING_WORKFLOW,
} from './content/bootstrap';

const API_URL = process.env.API_URL;
const WALLET = process.env.PHAM_WALLET_ADDRESS;
const PRIVATE_KEY = process.env.PHAM_PRIVATE_KEY;
const LIVE = !!(API_URL && WALLET && PRIVATE_KEY);

async function main() {
  console.log(LIVE ? '— LIVE seed against ' + API_URL : '— DRY validation only —');

  // 1. DAG validity check
  const dag = isWorkflowDagValid(MARKETING_WORKFLOW.steps);
  if (dag.ok === false) throw new Error(`bad workflow DAG: ${dag.reason}`);
  console.log('  ✅ workflow DAG valid');

  // 2. cost math
  const total = MARKETING_WORKFLOW.steps.reduce((sum, s) => {
    const p =
      s.skillRef?.priceUsdc ??
      s.brainAskRef?.priceUsdc ??
      '0';
    return sum + Number(p);
  }, 0);
  console.log(`  ✅ step-cost sum = $${total.toFixed(2)} (buyer pays $${MARKETING_WORKFLOW.defaultPriceUsdc})`);

  if (!LIVE) {
    console.log('\nDRY mode complete. Set API_URL + PHAM_WALLET_ADDRESS + PHAM_PRIVATE_KEY to publish.');
    return;
  }

  const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
  const headers = {
    'Content-Type': 'application/json',
    'x-wallet-address': WALLET!,
    'x-chain': 'sui',
  };

  // 3. Publish brains
  const brainIds: Record<string, number> = {};
  for (const b of BOOTSTRAP_BRAINS) {
    const r = await fetch(`${API_URL}/v3/agents/from-brain`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: b.title,
        description: b.body.slice(0, 280),
        tags: b.tags,
        chain: 'sui',
        pricing: { sui_usdc: b.pricePerQueryUsdc },
      }),
    });
    if (!r.ok) {
      console.warn(`  ⚠ brain ${b.workflowKey}: ${r.status}`);
      continue;
    }
    const j = (await r.json()) as { id: number };
    brainIds[b.workflowKey] = j.id;
    console.log(`  ✅ brain ${b.workflowKey} → id=${j.id}`);
  }

  // 4. Publish skills (each is signed locally then posted)
  for (const s of BOOTSTRAP_SKILLS) {
    const unsigned: Omit<Skill, 'signature'> = {
      skillKey: s.skillKey,
      manifest: {
        skillKey: s.skillKey,
        name: s.name,
        description: s.description,
        inputSchema: s.inputSchema,
        outputSchema: s.outputSchema,
        endpoint: s.endpoint,
      },
      defaultPriceUsdc: s.defaultPriceUsdc,
      signer: account.address,
      createdAt: Date.now(),
    };
    const sig = await account.signMessage({ message: skillSigningMessage(unsigned as any) });
    const r = await fetch(`${API_URL}/v3/skills`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...unsigned, signature: sig, chain: 'sui' }),
    });
    if (!r.ok) {
      console.warn(`  ⚠ skill ${s.skillKey}: ${r.status} ${await r.text()}`);
      continue;
    }
    console.log(`  ✅ skill ${s.skillKey} published`);
  }

  // 5. Publish marketing workflow (resolve brainAskRef.brainId from brainIds map)
  const resolvedSteps = MARKETING_WORKFLOW.steps.map((step) => {
    if (step.type === 'brain_ask' && step.brainAskRef) {
      // Steps 2/4 use marketing-icp + copy-pro respectively per dossier §4.2.
      const brainKey =
        step.id === 'step-2-personas'
          ? 'marketing-icp'
          : step.id === 'step-4-emails'
            ? 'copy-pro'
            : 'copy-pro';
      const id = brainIds[brainKey];
      if (!id) throw new Error(`missing brain id for ${brainKey}`);
      return { ...step, brainAskRef: { ...step.brainAskRef, brainId: id } };
    }
    return step;
  });

  const wfUnsigned: Omit<Workflow, 'signature'> = {
    workflowKey: MARKETING_WORKFLOW.workflowKey,
    name: MARKETING_WORKFLOW.name,
    description: MARKETING_WORKFLOW.description,
    steps: resolvedSteps,
    derivedFrom: [],
    defaultPriceUsdc: MARKETING_WORKFLOW.defaultPriceUsdc,
    revenueSplit: { authorBps: MARKETING_WORKFLOW.authorBps, platformBps: MARKETING_WORKFLOW.platformBps },
    signer: account.address,
    createdAt: Date.now(),
  };
  const wfSig = await account.signMessage({ message: workflowSigningMessage(wfUnsigned as any) });

  const wfPost = await fetch(`${API_URL}/v3/workflows`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      workflow_key: wfUnsigned.workflowKey,
      name: wfUnsigned.name,
      description: wfUnsigned.description,
      steps: wfUnsigned.steps,
      default_price_usdc: wfUnsigned.defaultPriceUsdc,
      author_bps: wfUnsigned.revenueSplit.authorBps,
      platform_bps: wfUnsigned.revenueSplit.platformBps,
      published: true,
      kya_required: false,
      min_reputation: 0,
      signer: wfUnsigned.signer,
      signature: wfSig,
      // sui_object_id + manifest_blob_id come from the publish wizard
      // (real Sui txn + Walrus upload). For a manual-seed test, the route
      // accepts these as fields the caller computed off-band.
      sui_object_id: process.env.SEED_SUI_OBJECT_ID ?? '0xdemo-sui-object-id',
      manifest_blob_id: process.env.SEED_WALRUS_BLOB_ID ?? 'walrus:demo-marketing-manifest',
      chain: 'sui',
    }),
  });
  if (!wfPost.ok) {
    console.error(`  ❌ workflow publish failed: ${wfPost.status} ${await wfPost.text()}`);
    process.exit(1);
  }
  const wfJson = (await wfPost.json()) as { id: string; sui_object_id: string };
  console.log(`  ✅ workflow ${MARKETING_WORKFLOW.workflowKey} → id=${wfJson.id}`);
  console.log(`\nMarketplace: ${API_URL.replace('/api', '')}/marketplace?type=workflow`);
  console.log(`Sui object: ${wfJson.sui_object_id}`);
}

main().catch((e) => {
  console.error('seed crashed:', e?.message ?? e);
  process.exit(1);
});
