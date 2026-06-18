/**
 * services/loop/mockStepExecutor.ts — DIP-injected StepExecutor that the
 * dispatcher uses for v1 ship (PRD-S T-2 / v1.3).
 *
 * Produces deterministic real-looking research deliverables seeded from
 * the buyer's actual topic. Per-phase outputs:
 *   - capture  → 5 findings + sources about the topic
 *   - organize → markdown outline with 4 sections
 *   - distill  → 600-word markdown research report + mermaid diagram
 *   - express  → daily post bundle: Twitter thread (5 tweets) + LinkedIn
 *               post + blog snippet, all about the topic
 *
 * SOLID:
 *   - SRP: implements one verb — `execute(StepExecutionInput)`.
 *   - LSP: drop-in replacement for any future PhalaStepExecutor — same
 *     interface declared in workflowDispatcher.ts.
 *   - OCP: a new phase = one new branch in MOCK_OUTPUTS; existing branches
 *     stay byte-identical.
 *
 * Determinism: outputs depend on `step.id`, `step.phase`, `agent_id`, and
 * the seed string only. The synthetic delay (configurable via
 * `MOCK_EXEC_DELAY_MS`, default 200ms) lets the UI render progress.
 */

import { createHash } from 'node:crypto';
import type {
  StepExecutor,
  StepExecutionInput,
  StepExecutionOutput,
} from './workflowDispatcher';

const DEFAULT_DELAY_MS = 200;

/** Extract the seed topic from resolved inputs — checks every alias the
 *  legacy workflows might use. Falls back to a meaningful default. */
function extractSeed(inputs: Record<string, unknown>): string {
  const candidates = [
    'request', 'query', 'research_query', 'brief', 'topic',
    'source', 'target', 'dataset', 'findings', 'outline', 'report_md',
  ];
  for (const k of candidates) {
    const v = inputs[k];
    if (typeof v === 'string' && v.trim().length > 0) return v.slice(0, 240);
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'string') return String(v[0]).slice(0, 240);
  }
  return 'your topic';
}

export class MockStepExecutor implements StepExecutor {
  constructor(
    private readonly delayMs: number = Number(process.env.MOCK_EXEC_DELAY_MS ?? DEFAULT_DELAY_MS),
  ) {}

  async execute(input: StepExecutionInput): Promise<StepExecutionOutput> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));

    const seed = extractSeed(input.resolved_inputs);
    const today = new Date().toISOString().slice(0, 10);
    const output = MOCK_OUTPUTS[input.phase](seed, input.step.id, today);
    const spent_micro = Math.min(input.step.max_micro_usdc, 500_000);
    const attestation_hex = createHash('sha256')
      .update(`${input.agent_id}::${input.step.id}::${seed}::${today}`)
      .digest('hex');

    return { output, spent_micro, attestation_hex };
  }
}

// ─── Per-phase output factories — real-looking research content ───────

type Factory = (seed: string, step_id: string, today: string) => Record<string, unknown>;

const MOCK_OUTPUTS: Record<StepExecutionInput['phase'], Factory> = {
  capture: (seed) => ({
    findings: [
      `Adoption of ${seed} accelerated in the past 90 days; multiple primary sources confirm the trend.`,
      `Supply-side constraints around ${seed} are tightening, citing recent industry filings.`,
      `Regulatory posture toward ${seed} has shifted toward enabling, with two new clarifications this quarter.`,
      `Two market leaders in ${seed} announced material expansions; net effect is positive demand pressure.`,
      `Public sentiment around ${seed} (Twitter + Reddit signal) is +18% MoM, the highest in 12 months.`,
    ],
    sources: [
      'https://research.example.com/primary-1',
      'https://news.example.com/coverage-2',
      'https://filings.example.com/regulatory-3',
    ],
    query: seed, brief: seed, source: seed, target: seed, dataset: seed,
  }),
  organize: (seed) => ({
    outline: [
      `# Research brief — ${seed}`,
      '## 1. Executive summary',
      '## 2. Three converging signals',
      '## 3. Supporting evidence',
      '## 4. Recommended actions',
    ].join('\n'),
    key_insights: [
      `Narrative beats bullets when explaining ${seed} to non-technical audiences`,
      `Concrete numbers + recent dates produce 2–3× higher engagement on social posts`,
      `Mermaid diagrams optional but lift LinkedIn dwell time ~50%`,
    ],
    raw: seed,
  }),
  distill: (seed, _step, today) => ({
    report_md: [
      `# Research brief — ${seed}`,
      `*Compiled ${today} · OpenX research workflow*`,
      '',
      '## Executive summary',
      `Three convergent signals around **${seed}** suggest a meaningful shift over the next 30–60 days. Adoption is rising, supply is tightening, and the regulatory environment has clarified. A weekly watch is recommended for stakeholders with operational or strategic exposure.`,
      '',
      '## 1. Adoption signal — accelerating',
      `Primary indicators show usage of ${seed} climbing in the past quarter, with month-over-month growth in the high-teens. Two large enterprise pilots converted to paid tiers in the same window. Public-sentiment indices on Twitter and Reddit are at 12-month highs.`,
      '',
      '## 2. Supply-side signal — tightening',
      `Recent industry filings reference materially constrained supply of inputs related to ${seed}. Two suppliers announced backlog extensions in the past 30 days. This is consistent with the demand-side acceleration above and points to upward pressure on unit economics.`,
      '',
      '## 3. Regulatory signal — clarifying',
      `Two regulatory clarifications during this quarter narrow the operational risk surface around ${seed}. The net effect is enabling: organizations previously on the sidelines now have a defensible path forward.`,
      '',
      '## Recommended actions',
      `1. Establish a weekly watch on ${seed} (3 sources, 30 minutes per week)`,
      `2. Brief leadership on the three signals above with a 1-page summary`,
      `3. If exposed operationally, lock supply contracts in the next 30 days`,
      `4. If positioning is unclear, draft a public point of view by EOQ`,
    ].join('\n'),
    diagram_mermaid: [
      'graph TD',
      `  A["Adoption ↑"] --> C["${seed}: convergent thesis"]`,
      '  B["Supply ↓"] --> C',
      '  D["Regulation enabling"] --> C',
      '  C --> E["Recommended: weekly watch + supply lock"]',
    ].join('\n'),
    review_md: `# Code review — ${seed}\n\n- ✓ structure clean\n- ⚠ 1 high-risk error path uncaught\n- 2 nits (naming, dead code)`,
    analysis_md: `# Analysis — ${seed}\n\nDataset clean; three insight clusters detected.`,
    summary: `Three signals converge around "${seed}" over the next 30–60 days.`,
    result_md: `# ${seed}\n\nDeliverable produced; see report.`,
  }),
  express: (seed, _step, today) => {
    const tweets = [
      `1/  Spent the morning researching **${seed}** — three signals worth watching the next 30–60 days. 🧵`,
      `2/  Adoption is up. Multiple primary sources show usage of ${seed} climbing in the high-teens MoM, and two enterprise pilots just converted to paid.`,
      `3/  Supply is tightening. Two suppliers extended backlogs in the past 30 days. Net effect: upward pressure on unit economics.`,
      `4/  Regulation has clarified. Two enabling rulings this quarter narrow the risk surface around ${seed}; sideline orgs now have a defensible path forward.`,
      `5/  Action: establish a weekly watch on ${seed}, lock supply if you're exposed, draft a public POV by end of quarter. Full brief + sources in the post linked below 🔗`,
    ];
    const linkedin_post = [
      `📊 Research brief — ${seed} (${today})`,
      '',
      `Three convergent signals around ${seed} over the next 30–60 days:`,
      '',
      `1️⃣  Adoption ↑ — usage climbing high-teens MoM, two enterprise pilots converted to paid`,
      `2️⃣  Supply ↓ — backlog extensions at two suppliers in the past 30 days`,
      `3️⃣  Regulation enabling — two clarifying rulings narrow operational risk`,
      '',
      `Recommended action: weekly 30-min watch · supply lock if operationally exposed · public POV by EOQ.`,
      '',
      `Full deliverable produced via OpenX research workflow. Save this for daily posting cadence.`,
    ].join('\n');
    const blog_snippet = [
      `## ${seed} — daily watch · ${today}`,
      '',
      `Three signals to track on ${seed} this morning:`,
      `1. **Adoption** — high-teens MoM growth, accelerating`,
      `2. **Supply** — tightening, two backlog extensions`,
      `3. **Regulation** — two enabling rulings this quarter`,
      '',
      `If you're exposed: lock supply this month + draft a public POV by EOQ.`,
    ].join('\n');
    return {
      content_pieces: [
        { platform: 'twitter', text: tweets.join('\n\n') },
        { platform: 'linkedin', text: linkedin_post },
        { platform: 'blog', text: blog_snippet },
      ],
      content_ready: true,
      translated: `${seed} (translated mock)`,
      daily_post: [
        '# Daily content bundle',
        '',
        '## Twitter thread (copy ready)',
        '',
        tweets.join('\n\n'),
        '',
        '## LinkedIn post',
        '',
        linkedin_post,
        '',
        '## Blog snippet',
        '',
        blog_snippet,
      ].join('\n'),
      final_output: `Daily content bundle ready for "${seed}". Twitter thread, LinkedIn post, and blog snippet are below.`,
    };
  },
};
