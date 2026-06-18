/**
 * services/loop/paraClassifier.ts — PRD-W v1.1 FINAL §"Decision 4".
 *
 * 5 deterministic classification rules applied in priority order. Pure
 * function — no I/O, no async. Every L4 cognitive memory write passes
 * through here exactly once.
 *
 * Rules (locked in the spec):
 *   1. YAML explicit override                                 → use it
 *   2. YAML declares `area_slug`                              → kind='area'
 *   3. Repeat buyer for an existing area                      → kind='project' linked
 *   4. Output schema indicates a Resource (template/dataset)  → kind='resource'
 *   5. Default                                                → kind='project'
 *   (Rule 6 — auto-archive — is NOT here; it lives in the dailyArchivalPass cron.)
 *
 * SOLID:
 *   - SRP: pure classification only. No DB, no Walrus, no Sui. Caller gates I/O.
 *   - OCP: rules are an ordered tuple — add a new rule by inserting in the list.
 *   - LSP: every rule has the same `(input) → ParaTag | null` shape.
 */

export type ParaKind = 'project' | 'area' | 'resource' | 'archive';

export interface ParaTag {
  para_kind: ParaKind;
  area_slug: string | null;
}

export interface ClassifyInput {
  /** Workflow YAML's optional `para` block (Rule 1+2). */
  yaml_default_kind?: ParaKind;
  yaml_area_slug?: string;
  /** Has this buyer hired this same agent in the same area before? (Rule 3) */
  is_repeat_buyer_in_area?: boolean;
  inferred_area_slug?: string | null;
  /** Step output_schema kinds — used for Rule 4. */
  output_artifact_kinds?: string[];
}

const RESOURCE_SIGNALS = new Set([
  'template', 'dataset', 'prompt-library', 'reference', 'lookup',
  'tone-template', 'style-guide', 'glossary',
]);

/**
 * Classify a single L4 write. Returns `{para_kind, area_slug}`. Never throws.
 */
export function classifyPara(input: ClassifyInput): ParaTag {
  // Rule 1 — YAML explicit override wins.
  if (input.yaml_default_kind) {
    return { para_kind: input.yaml_default_kind, area_slug: input.yaml_area_slug ?? null };
  }

  // Rule 2 — YAML declares area_slug → it IS an area.
  if (input.yaml_area_slug && input.yaml_area_slug.trim() !== '') {
    return { para_kind: 'area', area_slug: input.yaml_area_slug };
  }

  // Rule 3 — repeat buyer in an existing area → project linked to that area.
  if (input.is_repeat_buyer_in_area && input.inferred_area_slug) {
    return { para_kind: 'project', area_slug: input.inferred_area_slug };
  }

  // Rule 4 — every output kind is a Resource signal → resource.
  if (
    input.output_artifact_kinds &&
    input.output_artifact_kinds.length > 0 &&
    input.output_artifact_kinds.every((k) => RESOURCE_SIGNALS.has(k.toLowerCase()))
  ) {
    return { para_kind: 'resource', area_slug: null };
  }

  // Rule 5 — default.
  return { para_kind: 'project', area_slug: input.inferred_area_slug ?? null };
}

/**
 * Bulk-classify N rows for the upgrade-wizard preview path. Returns the
 * tag PLUS a confidence flag (`'rule-1' .. 'rule-5'`) for UI rendering.
 */
export function classifyParaWithRule(
  input: ClassifyInput,
): ParaTag & { rule: 1 | 2 | 3 | 4 | 5 } {
  if (input.yaml_default_kind) {
    return {
      para_kind: input.yaml_default_kind,
      area_slug: input.yaml_area_slug ?? null,
      rule: 1,
    };
  }
  if (input.yaml_area_slug && input.yaml_area_slug.trim() !== '') {
    return { para_kind: 'area', area_slug: input.yaml_area_slug, rule: 2 };
  }
  if (input.is_repeat_buyer_in_area && input.inferred_area_slug) {
    return { para_kind: 'project', area_slug: input.inferred_area_slug, rule: 3 };
  }
  if (
    input.output_artifact_kinds &&
    input.output_artifact_kinds.length > 0 &&
    input.output_artifact_kinds.every((k) => RESOURCE_SIGNALS.has(k.toLowerCase()))
  ) {
    return { para_kind: 'resource', area_slug: null, rule: 4 };
  }
  return {
    para_kind: 'project',
    area_slug: input.inferred_area_slug ?? null,
    rule: 5,
  };
}

/** Auto-classify a workflow step's CODE phase (PRD-W v1.1 §"Decision 3"). */
export type CodePhase = 'capture' | 'organize' | 'distill' | 'express';

export interface PhaseInferInput {
  step_id: string;
  depends_on: string[];
  /** All sibling step_ids referencing this step in their depends_on. */
  dependents: string[];
  output_schema_keys?: string[];
}

const DISTILL_SIGNALS = ['report', 'diagram', 'summary', 'outline', 'analysis', '_md', '_mermaid'];

export function inferPhase(input: PhaseInferInput): CodePhase {
  if (input.depends_on.length === 0) return 'capture';
  if (input.dependents.length === 0) return 'express';
  if (
    input.output_schema_keys &&
    input.output_schema_keys.some((k) =>
      DISTILL_SIGNALS.some((sig) => k.toLowerCase().includes(sig)),
    )
  ) {
    return 'distill';
  }
  return 'organize';
}
