/**
 * seed-memwal-lighthouse.ts
 *
 * Bootstraps the four PRD-08 §13 / PRD-12 §4.3 lighthouse brains by hitting
 * the public `/v3/memory/marketplace/publish` route once per brain. The
 * route caches the metadata in Postgres; the on-chain MemWalBrain object is
 * meant to exist already (created via `sui client call openx_memwal_marketplace::publish_brain`
 * in production). This script seeds the *catalog cache* so the marketplace
 * UI shows a non-empty grid out of the box.
 *
 *   npm run seed:memwal-lighthouse
 *
 * Idempotent — the route's INSERT ... ON CONFLICT DO UPDATE handles re-runs.
 *
 * Required env:
 *   API_URL                          (default http://localhost:3001)
 *   PHAM_WALLET_ADDRESS              caller wallet for the publish POSTs
 *   MEMWAL_ACCOUNT_ID                Sui MemWalAccount object id (used for all four)
 *   SEED_LIGHTHOUSE_SUI_OBJECT_PREFIX optional override for fake sui object ids
 */

const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const wallet = process.env.PHAM_WALLET_ADDRESS;
const memwalAccountId = process.env.MEMWAL_ACCOUNT_ID;
const objectPrefix = process.env.SEED_LIGHTHOUSE_SUI_OBJECT_PREFIX ?? '0xseedmemwal';

if (!wallet || !memwalAccountId) {
  console.error('PHAM_WALLET_ADDRESS + MEMWAL_ACCOUNT_ID are required.');
  process.exit(1);
}

interface LighthouseBrain {
  suiObjectId: string;
  namespace: string;
  title: string;
  description: string;
  pricePerQueryUsdc: string;
  cognitiveLevel: 1 | 2 | 3 | 4 | 5;
  attestationRequired: 0 | 1 | 2;
}

const LIGHTHOUSE: LighthouseBrain[] = [
  {
    suiObjectId: `${objectPrefix}-1`,
    namespace: 'pham-marketing-l5',
    title: 'Marketing 7-step workflow — reflective traces',
    description:
      'L5 reflective brain — distilled rules from running the 7-step marketing DAG. Each query returns the workflow rule that fits your prompt + a Phala-attested rationale.',
    pricePerQueryUsdc: '5.00',
    cognitiveLevel: 5,
    attestationRequired: 1, // phala-tee
  },
  {
    suiObjectId: `${objectPrefix}-2`,
    namespace: 'n-payment-x402-catalog',
    title: 'n-payment x402 catalog — paid MCP services',
    description:
      'L2 semantic brain over the public x402 bazaar — endpoints, pricing, capabilities. Updated weekly. Per-query recall is curated to the top-5 most-relevant services.',
    pricePerQueryUsdc: '0.01',
    cognitiveLevel: 2,
    attestationRequired: 0,
  },
  {
    suiObjectId: `${objectPrefix}-3`,
    namespace: 'kinetic-somnia-procedural-l4',
    title: 'Kinetic Somnia agent — procedural workflow',
    description:
      'L4 procedural workflow — step-by-step recipes for running Kinetic strategies on Somnia. Each query returns a runnable plan with ordered tool calls.',
    pricePerQueryUsdc: '0.50',
    cognitiveLevel: 4,
    attestationRequired: 1,
  },
  {
    suiObjectId: `${objectPrefix}-4`,
    namespace: 'minebean-bean-strategy-l3',
    title: 'Minebean BEAN strategy MCP',
    description:
      'L3 long-term knowledge — gamified ETH-mining strategies on Base for BEAN holders. Each query returns the strategy + risk profile + expected APY.',
    pricePerQueryUsdc: '0.05',
    cognitiveLevel: 3,
    attestationRequired: 0,
  },
];

async function publish(brain: LighthouseBrain) {
  const r = await fetch(`${API_URL}/v3/memory/marketplace/publish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-wallet-address': wallet!,
      'x-chain': 'sui',
    },
    body: JSON.stringify({
      ...brain,
      memwalAccountId,
      kyaRequired: false,
      sovereigntyProofUrl: '',
    }),
  });
  const text = await r.text();
  if (!r.ok) {
    console.log(`  ❌ ${brain.title} → ${r.status} ${text}`);
    return false;
  }
  console.log(`  ✅ ${brain.title} (${brain.suiObjectId})`);
  return true;
}

(async () => {
  console.log('— seed-memwal-lighthouse —\n');
  console.log(`API: ${API_URL}`);
  console.log(`Wallet: ${wallet}`);
  console.log(`MemWal account: ${memwalAccountId}\n`);

  let pass = 0;
  for (const b of LIGHTHOUSE) {
    if (await publish(b)) pass++;
  }
  console.log(`\n${pass}/${LIGHTHOUSE.length} lighthouse brains seeded.`);
  process.exit(pass === LIGHTHOUSE.length ? 0 : 1);
})();
