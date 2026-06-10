/**
 * scripts/content/bootstrap.ts
 *
 * Pham-authored lighthouse content for the tri-marketplace demo.
 *
 *   - 3 brains:    marketing-icp, copy-pro, fhe-research-stub
 *   - 3 skills:    ingest-url, seo-keywords, buffer-schedule
 *   - 1 workflow:  marketing-funnel-7step-v1
 *
 * Single file, pure data — no I/O. The seed script (scripts/seed-tri-marketplace.ts)
 * imports these constants and publishes them via the live API. The smoke script
 * (scripts/smoke-marketing-workflow.ts) runs the workflow against this content.
 */

import type { WorkflowStep } from '../../packages/sdk/src/cognitive/types';

// ─── Brain corpora (small — Tatum × Walrus demo only needs to demonstrate shape) ─

export const BRAIN_MARKETING_ICP = {
  workflowKey: 'marketing-icp',
  title: 'Marketing ICP — buyer personas',
  tags: ['marketing', 'icp', 'personas'],
  pricePerQueryUsdc: '0.20',
  body: `# Marketing ICP — Buyer Personas

## Persona 1 — The Crypto-Native Builder
- Demographics: 28-40, lives in major US/EU/APAC tech hubs.
- JTBD: ship a Web3 app that wins early users without burning runway.
- Pain: tooling fragmented; finding paying customers is harder than building.
- Channel: X, Farcaster, Mirror, Discord builder rooms.
- Buying trigger: a piece that clearly solves a specific build problem.

## Persona 2 — The Indie Researcher
- Demographics: 25-45, globally distributed, ex-academic or analyst.
- JTBD: monetize expertise without becoming a creator.
- Pain: existing platforms either gatekeep or silo their audience.
- Channel: Substack, Twitter/X, niche Telegram groups.
- Buying trigger: tooling that turns research into compounding income.

## Persona 3 — The Crypto-Treasurer
- Demographics: 30-55, ops/finance lead at a DAO or token-treasury.
- JTBD: make on-chain treasury decisions defensible to a multi-sig.
- Pain: data is fragmented across explorers, dashboards, and Discords.
- Channel: enterprise Slack, peer DAO ops calls, on-chain alerts.
- Buying trigger: software that produces an auditable decision log.
`,
};

export const BRAIN_COPY_PRO = {
  workflowKey: 'copy-pro',
  title: 'Copy-Pro — copywriting patterns',
  tags: ['marketing', 'copy', 'email', 'social'],
  pricePerQueryUsdc: '0.30',
  body: `# Copy-Pro — Copywriting Patterns

## Email patterns (5-step nurture)
1. **Curiosity hook** — one specific outcome, no abstraction.
2. **Proof-of-life** — link to a real artifact (receipt, dashboard, repo).
3. **Cost-to-action** — what does it cost the reader to try? Make it tiny.
4. **Asymmetric reward** — what they win vs what they risk.
5. **One-line CTA** — never two.

## Social patterns
- LinkedIn: lead with the *number*, then the *story*, then the *ask*.
- X/Twitter: lead with a *contrarian claim* the rest of the thread defends.

## Subject-line skeletons
- "How [persona] earned $X by [verb]ing [noun]"
- "Why [common belief] is wrong, in 90 seconds"
- "I shipped [thing]. It cost [time]. Here's the receipt."
`,
};

export const BRAIN_FHE_RESEARCH = {
  workflowKey: 'fhe-research-stub',
  title: 'FHE Research — overview',
  tags: ['fhe', 'cryptography', 'research'],
  pricePerQueryUsdc: '0.05',
  body: `# FHE Research — Overview (Stub)

Fully Homomorphic Encryption permits computation on ciphertext without decryption.
Threshold variants (Fhenix CoFHE, Sui Seal IBE) split decryption authority across
N nodes; t < N collusion is required to recover plaintext.

OpenX uses Fhenix CoFHE on Arbitrum (Standard tier) and Sui Seal threshold IBE +
Phala TEE inference (Trustless tier). Per-call SEAL approvers gate key release on
a fresh paid Subscription within a 60-second window.
`,
};

export const BOOTSTRAP_BRAINS = [BRAIN_MARKETING_ICP, BRAIN_COPY_PRO, BRAIN_FHE_RESEARCH];

// ─── Skill manifests ──────────────────────────────────────────────────────

export const SKILL_INGEST_URL = {
  skillKey: 'ingest-url',
  name: 'ingest-url',
  description: 'Fetch a URL and return its title + plaintext body + content hash.',
  inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  outputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      title: { type: 'string' },
      text: { type: 'string' },
      contentHash: { type: 'string' },
    },
  },
  endpoint: { type: 'internal' as const, ref: 'ingest-url' },
  defaultPriceUsdc: '0.05',
};

export const SKILL_SEO_KEYWORDS = {
  skillKey: 'seo-keywords',
  name: 'seo-keywords',
  description: 'Return the top-N SEO bigram/unigram keywords from a text body.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' }, limit: { type: 'number' } },
    required: ['text'],
  },
  outputSchema: { type: 'object' },
  endpoint: { type: 'internal' as const, ref: 'seo-keywords' },
  defaultPriceUsdc: '0.10',
};

export const SKILL_BUFFER_SCHEDULE = {
  skillKey: 'buffer-schedule',
  name: 'buffer-schedule',
  description: 'Return a deterministic publish schedule for an array of social posts.',
  inputSchema: { type: 'object', properties: { posts: { type: 'array' } } },
  outputSchema: { type: 'object' },
  endpoint: { type: 'internal' as const, ref: 'buffer-schedule' },
  defaultPriceUsdc: '0.05',
};

export const BOOTSTRAP_SKILLS = [SKILL_INGEST_URL, SKILL_SEO_KEYWORDS, SKILL_BUFFER_SCHEDULE];

// ─── Workflow: marketing-funnel-7step-v1 ──────────────────────────────────
//
// Per dossier 06-skills-brains-workflows-marketplace.md §4.2.
// Topology:
//
//   1 ingest ─┬─→ 2 personas ─┐
//             ├─→ 3 SEO ──────┼─→ 5 social ─→ 6 schedule ─→ 7 metrics
//             └─→ 4 emails  ──┘
//
// Cost summary (matches dossier table):
//   ingest 0.05 + personas 0.20 + SEO 0.10 + emails 0.30
//   + social 0.20 + schedule 0.05 + metrics 0.00 = 0.90 step-cost
//   buyer pays 1.50 → 0.075 platform + 0.525 author markup + 0.90 step-cost.

export const MARKETING_WORKFLOW_STEPS: WorkflowStep[] = [
  {
    id: 'step-1-ingest',
    name: 'Ingest URL',
    type: 'skill',
    skillRef: { url: 'internal:ingest-url', pricingMode: 'per-call', priceUsdc: '0.05' },
    dependsOn: [],
    inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
    outputSchema: { type: 'object' },
  },
  {
    id: 'step-2-personas',
    name: 'Generate personas',
    type: 'brain_ask',
    brainAskRef: {
      brainId: 0, // resolved at seed time
      queryTemplate: 'Given this site context: {text}, list the top 3 buyer personas.',
      priceUsdc: '0.20',
    },
    dependsOn: ['step-1-ingest'],
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
  },
  {
    id: 'step-3-seo',
    name: 'SEO keywords',
    type: 'skill',
    skillRef: { url: 'internal:seo-keywords', pricingMode: 'per-call', priceUsdc: '0.10' },
    dependsOn: ['step-1-ingest'],
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
  },
  {
    id: 'step-4-emails',
    name: '5-email nurture sequence',
    type: 'brain_ask',
    brainAskRef: {
      brainId: 0,
      queryTemplate: 'Draft 5 nurture emails matching personas {b} for keywords {c}.',
      priceUsdc: '0.30',
    },
    dependsOn: ['step-1-ingest'],
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
  },
  {
    id: 'step-5-social',
    name: '5 social posts',
    type: 'brain_ask',
    brainAskRef: {
      brainId: 0,
      queryTemplate: 'Draft 5 LinkedIn + X posts using personas {b}, emails {d}.',
      priceUsdc: '0.20',
    },
    dependsOn: ['step-2-personas', 'step-4-emails'],
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
  },
  {
    id: 'step-6-schedule',
    name: 'Buffer schedule',
    type: 'skill',
    skillRef: { url: 'internal:buffer-schedule', pricingMode: 'per-call', priceUsdc: '0.05' },
    dependsOn: ['step-5-social'],
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
  },
  {
    id: 'step-7-metrics',
    name: 'Metrics report',
    type: 'transform',
    transform: { fn: 'merge', args: { with: { reportVersion: 'v1' } } },
    dependsOn: ['step-6-schedule'],
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
  },
];

export const MARKETING_WORKFLOW = {
  workflowKey: 'marketing-funnel-7step-v1',
  name: 'Marketing Funnel — 7 Steps',
  description:
    'Ingest a URL → 3 buyer personas → SEO keywords → 5 nurture emails → 5 social posts → scheduled posts → metrics report. $1.50/exec on Sui testnet.',
  steps: MARKETING_WORKFLOW_STEPS,
  defaultPriceUsdc: '1.50',
  authorBps: 9500,
  platformBps: 500,
};

// ─── Expected step-cost summary used by the smoke test ────────────────────

export const EXPECTED_STEP_COSTS_USDC: Record<string, string> = {
  'step-1-ingest': '0.05',
  'step-2-personas': '0.20',
  'step-3-seo': '0.10',
  'step-4-emails': '0.30',
  'step-5-social': '0.20',
  'step-6-schedule': '0.05',
  'step-7-metrics': '0',
};

export const EXPECTED_STEP_COST_TOTAL_USDC = '0.90';
