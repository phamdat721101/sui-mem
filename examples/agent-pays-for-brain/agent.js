#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * agent-pays-for-brain — runnable showcase.
 *
 * Tells the v1.0 story end to end:
 *   1. Agent verifies ERC-8004 identity (mock).
 *   2. Owner publishes a Sui brain (Seal IBE + Walrus mock + Phala TEE mock).
 *   3. Agent subscribes (Trustless tier).
 *   4. Agent asks a question; gets a Phala-attested answer.
 *   5. Owner migrates the brain to Standard tier (cross-chain re-upload).
 *
 * Run: `npm run demo:agent` from the repo root after `npm run build`.
 */

require('@fhe-ai-context/sui-sdk'); // side-effect: registers 'sui' provider
const sdk = require('@fhe-ai-context/sdk');

const { createBrainClient, verifyAgent, migrateBrain } = sdk;

function step(n, msg) {
  console.log(`\n[${n}] ${msg}`);
}

(async () => {
  // ------------------------------------------------------------------
  step(1, 'Owner alice publishes a Trustless brain on Sui');
  // ------------------------------------------------------------------
  const alice = createBrainClient.forTier('trustless', {
    apiUrl: 'http://example.test',
    walletAddress: '0xalice000000000000000000000000000000000000',
  });
  await alice.subscribe('month');
  const upload = await alice.uploadEncrypted(
    'Solidity reentrancy guards: a state-mutex pattern that disables re-entry into a function before its state is fully updated.',
  );
  await alice.chat(
    'Reentrancy is mitigated by checks-effects-interactions: validate, then update state, then external call.',
    String(upload.brainId),
    'store',
  );
  await alice.publishBrain(upload.brainId, {
    title: 'Solidity Security 101',
    description: 'Common vulnerabilities and defences',
    tags: ['solidity', 'security', 'audit'],
  });
  console.log('   ✓ Brain published, id =', upload.brainId);

  // ------------------------------------------------------------------
  step(2, 'Agent presents an ERC-8004 KYA identity');
  // ------------------------------------------------------------------
  const agentAddress = '0xa67e7700000000000000000000000000000000ab';
  const { verified, signedProof } = await verifyAgent(agentAddress, 30);
  console.log('   ✓ verified =', verified, '· reputation =', signedProof.reputation);
  if (!verified) {
    console.error('   ! Agent reputation below threshold; aborting demo.');
    process.exit(1);
  }

  // ------------------------------------------------------------------
  step(3, 'Agent subscribes to alice\'s brain');
  // ------------------------------------------------------------------
  const agent = createBrainClient.forTier('trustless', {
    apiUrl: 'http://example.test',
    walletAddress: agentAddress,
  });
  const sub = await agent.subscribe('month');
  agent.setKYAClaim({
    agentAddress,
    reputation: signedProof.reputation,
    proof: signedProof.proof,
  });
  console.log('   ✓ subscription tx', sub.txHash, '· expires', sub.expiresAt.slice(0, 10));

  // ------------------------------------------------------------------
  step(4, 'Agent queries — answer comes back with a Phala TEE attestation');
  // ------------------------------------------------------------------
  // The agent and the owner are different clients with separate in-memory
  // stores. In production the agent reads the published brain via Sui RPC.
  // Here we simulate that by importing the brain into the agent's view.
  const ownerBrains = await alice.listBrains();
  const target = ownerBrains.find((b) => b.id === upload.brainId);
  if (!target) {
    console.error('   ! brain not visible in catalog');
    process.exit(1);
  }
  console.log(`   · catalog hit: "${target.title}" [${target.tags.join(', ')}] tier=${target.chain}`);

  // Agent runs the same query against alice's client (for demo simplicity).
  // A real cross-account flow would route via the sealed-content + Walrus blob refs published on chain.
  const response = await alice.chat('How do I prevent reentrancy?', String(upload.brainId), 'learn');
  console.log('   ✓ answer:', response.response.slice(0, 140), '...');
  console.log('   ✓ sources:', response.sources.join(', '));
  console.log(
    '   🛡  attestation:',
    JSON.stringify({
      provider: response.attestation?.provider,
      verified: response.attestation?.verified,
      issuedAt: response.attestation?.issuedAt,
    }),
  );

  // ------------------------------------------------------------------
  step(5, 'Cross-chain migration: alice re-publishes the brain on Standard');
  // ------------------------------------------------------------------
  // Sui→Sui in this mock; production would migrate Trustless→Standard via the
  // user-mediated flow described in docs/UNIFIED_FLOW_SPEC.md.
  const aliceStandard = createBrainClient.forTier('trustless', {
    apiUrl: 'http://example.test',
    walletAddress: '0xalice000000000000000000000000000000000000',
  });
  await aliceStandard.subscribe('month');

  const result = await migrateBrain({
    source: alice,
    sourceBrainId: upload.brainId,
    target: aliceStandard,
    targetMeta: {
      title: 'Solidity Security 101 (migrated)',
      description: 'Re-published',
      tags: ['solidity', 'migrated'],
    },
    onProgress: (p) => console.log(`   · migration step: ${p.step}${p.currentChunk !== undefined ? ` (chunk ${p.currentChunk + 1}/${p.totalChunks})` : ''}`),
  });
  console.log('   ✓ migrated', result.chunksMigrated, 'chunks → new brainId', result.targetBrainId);

  console.log('\n✅ Showcase complete.');
  console.log('   See docs/MASTER_PROPOSAL.md for architecture, GTM, and grant ask.');
})().catch((err) => {
  console.error('\n❌ Showcase failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
