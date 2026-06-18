/**
 * services/loop/workflowSynthesizer.ts — auto-generate a v1.1 workflow YAML
 * from a plain-English service description + a category chip (PRD-S).
 *
 * Pure function. No I/O, no LLM dep — deterministic templates per category
 * + cheap keyword extraction. Always produces a workflow that passes
 * `validateWorkflow` (the route handler asserts that gate before returning
 * to the seller, so a buggy template fails loudly in CI).
 *
 * SOLID:
 *   - SRP: one job — turn (description, category) into a Workflow.
 *   - OCP: a new category = one entry in CATEGORY_KEYWORDS + TEMPLATES;
 *     existing templates stay byte-identical.
 *   - LSP: signature stable; future LLM-backed implementation is a drop-in
 *     replacement (same shape, same return type).
 *
 * Future swap: when the Phala TEE prompt path is ready, inject an LlmClient
 * via the constructor pattern. v1.1 spine = deterministic templates only.
 */

import type { Workflow } from './workflowDispatcher';

export type Category = 'research' | 'writing' | 'translation' | 'code' | 'analysis' | 'other';

export interface SynthesizerInput {
  /** Plain-English service description, max 500 chars. */
  description: string;
  /** Optional category hint; if absent we infer it from keywords. */
  category?: Category;
  /** Optional area_slug seed; falls back to slug-of-description. */
  area_slug?: string;
}

export interface Synthesized {
  workflow: Workflow;
  /** Why we chose this shape — surfaced in the seller UI for transparency. */
  reasoning: string;
  /** Inferred from keywords when category not provided. */
  inferred_category: Category;
}

// ─── Category inference ────────────────────────────────────────────

const CATEGORY_KEYWORDS: Record<Category, string[]> = {
  research:    ['research', 'analyze', 'study', 'investigate', 'scan', 'monitor'],
  writing:     ['write', 'content', 'article', 'blog', 'post', 'thread', 'tweet', 'newsletter', 'social'],
  translation: ['translate', 'translation', 'localize', 'localise'],
  code:        ['code', 'review', 'refactor', 'debug', 'lint', 'audit'],
  analysis:    ['report', 'data', 'metrics', 'insight', 'trend', 'forecast'],
  other:       [],
};

export function inferCategory(description: string): Category {
  const text = description.toLowerCase();
  let best: Category = 'other';
  let best_score = 0;
  (Object.entries(CATEGORY_KEYWORDS) as [Category, string[]][]).forEach(([cat, words]) => {
    const score = words.reduce((n, w) => (text.includes(w) ? n + 1 : n), 0);
    if (score > best_score) {
      best_score = score;
      best = cat;
    }
  });
  return best;
}

// ─── Per-category templates (each must pass validateWorkflow) ─────────

const TEMPLATES: Record<Category, Workflow['steps']> = {
  research: [
    { id: 'capture',  capability: 'web_research',     phase: 'capture',  depends_on: [],
      inputs: { query: '{{ buyer.input.request }}' },
      max_micro_usdc: 5_000_000, risk_tier: 'medium', on_failure: 'retry-once' },
    { id: 'organize', capability: 'organize_findings', phase: 'organize', depends_on: ['capture'],
      inputs: { findings: '{{ steps.capture.output.findings }}' },
      max_micro_usdc: 2_000_000, risk_tier: 'low', on_failure: 'halt' },
    { id: 'distill',  capability: 'synthesize_report', phase: 'distill', depends_on: ['organize'],
      inputs: { outline: '{{ steps.organize.output.outline }}' },
      output_schema: { report_md: 'markdown', diagram_mermaid: 'mermaid' },
      max_micro_usdc: 8_000_000, risk_tier: 'high', on_failure: 'halt' },
    { id: 'express',  capability: 'finalize',         phase: 'express',  depends_on: ['distill'],
      inputs: { report_md: '{{ steps.distill.output.report_md }}' },
      max_micro_usdc: 3_000_000, risk_tier: 'medium', on_failure: 'continue-skip' },
  ],
  writing: [
    { id: 'capture',  capability: 'gather_context',  phase: 'capture',  depends_on: [],
      inputs: { brief: '{{ buyer.input.request }}' },
      max_micro_usdc: 3_000_000, risk_tier: 'medium', on_failure: 'retry-once' },
    { id: 'distill',  capability: 'draft_content',   phase: 'distill',  depends_on: ['capture'],
      inputs: { brief: '{{ steps.capture.output.brief }}' },
      output_schema: { draft_md: 'markdown' },
      max_micro_usdc: 6_000_000, risk_tier: 'medium', on_failure: 'halt' },
    { id: 'express',  capability: 'polish_publish',  phase: 'express',  depends_on: ['distill'],
      inputs: { draft: '{{ steps.distill.output.draft_md }}' },
      max_micro_usdc: 4_000_000, risk_tier: 'medium', on_failure: 'continue-skip' },
  ],
  translation: [
    { id: 'capture',  capability: 'extract_source',  phase: 'capture',  depends_on: [],
      inputs: { source: '{{ buyer.input.request }}' },
      max_micro_usdc: 1_500_000, risk_tier: 'low', on_failure: 'retry-once' },
    { id: 'express',  capability: 'translate',       phase: 'express',  depends_on: ['capture'],
      inputs: { text: '{{ steps.capture.output.source }}' },
      output_schema: { translated: 'text' },
      max_micro_usdc: 4_500_000, risk_tier: 'medium', on_failure: 'halt' },
  ],
  code: [
    { id: 'capture',  capability: 'read_repo',       phase: 'capture',  depends_on: [],
      inputs: { target: '{{ buyer.input.request }}' },
      max_micro_usdc: 4_000_000, risk_tier: 'low', on_failure: 'retry-once' },
    { id: 'distill',  capability: 'review',          phase: 'distill',  depends_on: ['capture'],
      inputs: { code: '{{ steps.capture.output.target }}' },
      output_schema: { review_md: 'markdown' },
      max_micro_usdc: 7_000_000, risk_tier: 'high', on_failure: 'halt' },
    { id: 'express',  capability: 'patch',           phase: 'express',  depends_on: ['distill'],
      inputs: { review: '{{ steps.distill.output.review_md }}' },
      max_micro_usdc: 5_000_000, risk_tier: 'high', on_failure: 'halt' },
  ],
  analysis: [
    { id: 'capture',  capability: 'fetch_data',       phase: 'capture',  depends_on: [],
      inputs: { dataset: '{{ buyer.input.request }}' },
      max_micro_usdc: 3_500_000, risk_tier: 'medium', on_failure: 'retry-once' },
    { id: 'organize', capability: 'clean_dataset',    phase: 'organize', depends_on: ['capture'],
      inputs: { raw: '{{ steps.capture.output.dataset }}' },
      max_micro_usdc: 2_500_000, risk_tier: 'low', on_failure: 'halt' },
    { id: 'distill',  capability: 'derive_insights',  phase: 'distill',  depends_on: ['organize'],
      inputs: { clean: '{{ steps.organize.output.raw }}' },
      output_schema: { analysis_md: 'markdown', summary: 'text' },
      max_micro_usdc: 6_000_000, risk_tier: 'high', on_failure: 'halt' },
    { id: 'express',  capability: 'package_report',   phase: 'express',  depends_on: ['distill'],
      inputs: { analysis: '{{ steps.distill.output.analysis_md }}' },
      max_micro_usdc: 3_000_000, risk_tier: 'medium', on_failure: 'continue-skip' },
  ],
  other: [
    { id: 'capture',  capability: 'capture',  phase: 'capture',  depends_on: [],
      inputs: { request: '{{ buyer.input.request }}' },
      max_micro_usdc: 3_000_000, risk_tier: 'medium', on_failure: 'retry-once' },
    { id: 'distill',  capability: 'distill',  phase: 'distill',  depends_on: ['capture'],
      inputs: { capture: '{{ steps.capture.output.request }}' },
      output_schema: { result_md: 'markdown' },
      max_micro_usdc: 5_000_000, risk_tier: 'medium', on_failure: 'halt' },
    { id: 'express',  capability: 'express',  phase: 'express',  depends_on: ['distill'],
      inputs: { distilled: '{{ steps.distill.output.result_md }}' },
      max_micro_usdc: 3_000_000, risk_tier: 'medium', on_failure: 'continue-skip' },
  ],
};

// ─── Slug helper (no `s.replace(/.../g)` regex deps — kept simple) ──

function slugify(s: string, max = 32): string {
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .join('-')
    .slice(0, max);
  return slug || 'general';
}

// ─── Public API ───────────────────────────────────────────────────

export function synthesizeWorkflow(input: SynthesizerInput): Synthesized {
  const description = (input.description ?? '').slice(0, 500).trim();
  if (!description) throw new Error('synthesize: description required');
  const inferred_category = input.category ?? inferCategory(description);
  const area_slug = input.area_slug ?? slugify(description);
  const steps = TEMPLATES[inferred_category];

  const workflow: Workflow = {
    version: 'v1.1',
    name: description.split(/[.!?]/)[0].slice(0, 64) || 'auto-generated',
    para: { default_kind: 'project', area_slug },
    steps,
  };

  const reasoning =
    `Detected category "${inferred_category}" → ${steps.length}-step ` +
    `${steps.map((s) => s.phase).join(' → ')} workflow. ` +
    `Default area_slug "${area_slug}" inferred from description; refine in editor before save.`;

  return { workflow, reasoning, inferred_category };
}
