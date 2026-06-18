'use client';

/**
 * /loop/seller/agent/[id]/workflow — edit the workflow YAML for an upgraded agent.
 *
 * View + edit the canonical workflow steps (id / capability / phase /
 * depends_on / max_micro_usdc / risk_tier). Saves via PATCH; the server
 * runs the same `validateWorkflow` the dispatcher uses → guaranteed-runnable.
 *
 * SOLID:
 *   - SRP: presentation + step editor. Validation lives server-side
 *     (single source of truth; same code as the dispatcher).
 *   - DIP: page depends on `api.getWorkflow` / `api.saveWorkflow` only.
 *   - OCP: adding a new step field = one column in the form, no other change.
 */

import { useEffect, useMemo, useState } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit';
import { useParams, useRouter } from 'next/navigation';
import { api, type WorkflowStep, type WorkflowYaml } from '@/lib/api';

type Phase = NonNullable<WorkflowStep['phase']>;
type RiskTier = NonNullable<WorkflowStep['risk_tier']>;
type FailurePolicy = NonNullable<WorkflowStep['on_failure']>;

const PHASES: Phase[] = ['capture', 'organize', 'distill', 'express'];
const RISKS: RiskTier[] = ['low', 'medium', 'high'];
const FAILURES: FailurePolicy[] = ['retry-once', 'halt', 'continue-skip'];

const STARTER_WORKFLOW: WorkflowYaml = {
  version: 'v1.1',
  name: 'untitled',
  para: { default_kind: 'project' },
  steps: [
    { id: 'research', capability: 'research', phase: 'capture', depends_on: [],
      max_micro_usdc: 5_000_000, risk_tier: 'medium' },
    { id: 'distill', capability: 'distill', phase: 'distill', depends_on: ['research'],
      output_schema: { report_md: 'markdown' },
      max_micro_usdc: 8_000_000, risk_tier: 'high' },
    { id: 'express', capability: 'express', phase: 'express', depends_on: ['distill'],
      max_micro_usdc: 5_000_000, risk_tier: 'medium' },
  ],
};

export default function AgentWorkflowEditorPage() {
  const params = useParams<{ id: string }>();
  const agentId = params?.id ?? '';
  const account = useCurrentAccount();
  const router = useRouter();

  const [workflow, setWorkflow] = useState<WorkflowYaml | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // Load latest workflow.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!account?.address || !agentId) return;
      try {
        const r = await api.getWorkflow(account.address, agentId);
        if (cancelled) return;
        setWorkflow(r.workflow ?? STARTER_WORKFLOW);
        setSavedAt(r.updated_at ?? null);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [account?.address, agentId]);

  const save = async () => {
    if (!account?.address || !workflow) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.saveWorkflow(account.address, agentId, workflow);
      setWorkflow(r.workflow);
      setSavedAt(r.updated_at);
    } catch (e) {
      setError(`save failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  if (!account?.address) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <h1 className="font-headline text-2xl font-bold">Workflow editor</h1>
        <p className="mt-3 text-on-surface-variant">Connect a Sui wallet to edit the workflow.</p>
      </div>
    );
  }

  if (!loaded || !workflow) {
    return <div className="mx-auto max-w-3xl p-6 text-on-surface-variant">Loading workflow…</div>;
  }

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-6">
      <header className="space-y-2">
        <button
          type="button"
          onClick={() => router.push(`/agent/${agentId}`)}
          className="font-mono text-xs text-on-surface-variant hover:text-on-surface"
        >
          ← agent detail
        </button>
        <h1 className="font-headline text-3xl font-bold">Workflow editor</h1>
        <p className="text-sm text-on-surface-variant font-mono">
          Agent: {agentId.slice(0, 12)}…{agentId.slice(-6)}
          {savedAt && <span className="ml-2 text-on-surface-variant/70">· saved {new Date(savedAt).toLocaleString()}</span>}
        </p>
      </header>

      {error && (
        <div className="rounded-lg border border-error/40 bg-error/10 p-3 text-sm text-error">{error}</div>
      )}

      <QuickBuildPanel
        agentId={agentId}
        onGenerated={(synth) => setWorkflow(synth.workflow)}
      />

      <MetadataPanel workflow={workflow} onChange={setWorkflow} />

      <StepListPanel workflow={workflow} onChange={setWorkflow} />

      <ValidationPanel workflow={workflow} />

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => setWorkflow(STARTER_WORKFLOW)}
          className="rounded-full border border-outline-variant/40 px-4 py-2 text-sm text-on-surface-variant hover:bg-on-surface/5"
        >
          Reset to template
        </button>
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="rounded-full bg-primary px-5 py-2 text-sm text-on-primary disabled:opacity-40"
        >
          {busy ? 'Saving…' : '✓ Save workflow'}
        </button>
      </div>
    </div>
  );
}

// ─── Metadata panel ────────────────────────────────────────────────

function MetadataPanel({
  workflow, onChange,
}: { workflow: WorkflowYaml; onChange: (w: WorkflowYaml) => void }) {
  return (
    <div className="space-y-3 rounded-xl border border-outline-variant/30 bg-surface p-5">
      <h2 className="font-mono text-sm uppercase tracking-wide text-on-surface-variant">Workflow metadata</h2>
      <div className="grid grid-cols-2 gap-3">
        <Field label="name">
          <input
            value={workflow.name}
            onChange={(e) => onChange({ ...workflow, name: e.target.value })}
            className="w-full rounded-md bg-surface-container-low px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </Field>
        <Field label="default area_slug (optional)">
          <input
            value={workflow.para?.area_slug ?? ''}
            onChange={(e) =>
              onChange({ ...workflow, para: { ...(workflow.para ?? {}), area_slug: e.target.value } })}
            placeholder="vietnam-ev-content"
            className="w-full rounded-md bg-surface-container-low px-3 py-2 font-mono text-sm focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </Field>
      </div>
    </div>
  );
}

// ─── Step list panel ───────────────────────────────────────────────

function StepListPanel({
  workflow, onChange,
}: { workflow: WorkflowYaml; onChange: (w: WorkflowYaml) => void }) {
  const updateStep = (idx: number, patch: Partial<WorkflowStep>) => {
    const steps = workflow.steps.map((s, i) => (i === idx ? { ...s, ...patch } : s));
    onChange({ ...workflow, steps });
  };

  const removeStep = (idx: number) => {
    const removed_id = workflow.steps[idx].id;
    const steps = workflow.steps
      .filter((_, i) => i !== idx)
      .map((s) => ({ ...s, depends_on: s.depends_on.filter((d) => d !== removed_id) }));
    onChange({ ...workflow, steps });
  };

  const addStep = () => {
    const id = `step-${workflow.steps.length + 1}`;
    onChange({
      ...workflow,
      steps: [...workflow.steps, {
        id, capability: 'inference', phase: 'organize', depends_on: [],
        max_micro_usdc: 3_000_000, risk_tier: 'medium', on_failure: 'halt',
      }],
    });
  };

  return (
    <div className="space-y-3 rounded-xl border border-outline-variant/30 bg-surface p-5">
      <div className="flex items-center justify-between">
        <h2 className="font-mono text-sm uppercase tracking-wide text-on-surface-variant">
          Steps ({workflow.steps.length}/20)
        </h2>
        <button
          type="button"
          onClick={addStep}
          disabled={workflow.steps.length >= 20}
          className="rounded-md border border-outline-variant/40 px-2.5 py-1 text-xs text-on-surface-variant hover:bg-on-surface/5 disabled:opacity-40"
        >
          + Add step
        </button>
      </div>

      <div className="space-y-2">
        {workflow.steps.map((step, idx) => (
          <StepRow
            key={`${step.id}-${idx}`}
            step={step}
            allIds={workflow.steps.filter((_, i) => i !== idx).map((s) => s.id)}
            onChange={(patch) => updateStep(idx, patch)}
            onRemove={() => removeStep(idx)}
          />
        ))}
      </div>
    </div>
  );
}

function StepRow({
  step, allIds, onChange, onRemove,
}: {
  step: WorkflowStep;
  allIds: string[];
  onChange: (patch: Partial<WorkflowStep>) => void;
  onRemove: () => void;
}) {
  const phaseColor: Record<Phase, string> = {
    capture:  'bg-blue-500/15 text-blue-300',
    organize: 'bg-amber-500/15 text-amber-300',
    distill:  'bg-purple-500/15 text-purple-300',
    express:  'bg-emerald-500/15 text-emerald-300',
  };
  const phase = (step.phase ?? 'organize') as Phase;

  return (
    <div className="rounded-lg border border-outline-variant/20 bg-surface-container-low p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ${phaseColor[phase]}`}>
          {phase}
        </span>
        <input
          value={step.id}
          onChange={(e) => onChange({ id: e.target.value })}
          className="w-32 rounded-md bg-surface px-2 py-1 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-primary"
          aria-label="step id"
        />
        <input
          value={step.capability}
          onChange={(e) => onChange({ capability: e.target.value })}
          placeholder="capability"
          className="flex-1 min-w-[10rem] rounded-md bg-surface px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <select
          value={phase}
          onChange={(e) => onChange({ phase: e.target.value as Phase })}
          className="rounded-md bg-surface px-2 py-1 font-mono text-xs"
          aria-label="phase"
        >
          {PHASES.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <button
          type="button"
          onClick={onRemove}
          className="rounded-md px-2 py-1 text-xs text-on-surface-variant hover:bg-error/10 hover:text-error"
          aria-label="remove step"
        >
          ✕
        </button>
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
        <Field label="depends_on">
          <DependsOnPicker
            value={step.depends_on}
            options={allIds}
            onChange={(v) => onChange({ depends_on: v })}
          />
        </Field>
        <Field label="max µUSDC">
          <input
            type="number"
            min={0}
            value={step.max_micro_usdc ?? 0}
            onChange={(e) => onChange({ max_micro_usdc: Number(e.target.value) })}
            className="w-full rounded-md bg-surface px-2 py-1 font-mono text-xs"
          />
        </Field>
        <Field label="risk · on_failure">
          <div className="flex gap-1">
            <select
              value={step.risk_tier ?? 'medium'}
              onChange={(e) => onChange({ risk_tier: e.target.value as RiskTier })}
              className="flex-1 rounded-md bg-surface px-2 py-1 font-mono text-xs"
            >
              {RISKS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <select
              value={step.on_failure ?? 'halt'}
              onChange={(e) => onChange({ on_failure: e.target.value as FailurePolicy })}
              className="flex-1 rounded-md bg-surface px-2 py-1 font-mono text-xs"
            >
              {FAILURES.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
        </Field>
      </div>
    </div>
  );
}

function DependsOnPicker({
  value, options, onChange,
}: { value: string[]; options: string[]; onChange: (v: string[]) => void }) {
  if (options.length === 0) {
    return <span className="block px-2 py-1 text-on-surface-variant/70">(no other steps)</span>;
  }
  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((id) => {
        const on = value.includes(id);
        return (
          <button
            key={id}
            type="button"
            onClick={() => toggle(id)}
            className={`rounded-md px-2 py-0.5 font-mono text-[10px] ${on ? 'bg-primary/20 text-primary' : 'bg-surface text-on-surface-variant'}`}
          >
            {on ? '✓ ' : ''}{id}
          </button>
        );
      })}
    </div>
  );
}

// ─── Live validation panel ────────────────────────────────────────

function ValidationPanel({ workflow }: { workflow: WorkflowYaml }) {
  const issues = useMemo(() => validateClient(workflow), [workflow]);
  if (issues.length === 0) {
    return (
      <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm text-emerald-300">
        ✓ workflow valid · {workflow.steps.length} step{workflow.steps.length === 1 ? '' : 's'} ·{' '}
        capture+express present · no cycles
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-300">
      <div className="mb-1 font-mono uppercase tracking-wide">⚠ {issues.length} issue{issues.length === 1 ? '' : 's'}</div>
      <ul className="list-disc pl-5 space-y-0.5 text-xs">
        {issues.map((i) => <li key={i}>{i}</li>)}
      </ul>
    </div>
  );
}

/** Client-side mirror of the server's validateWorkflow (advisory only;
 *  server's check is authoritative). */
function validateClient(w: WorkflowYaml): string[] {
  const out: string[] = [];
  if (!w.name) out.push('name is required');
  if (!w.steps?.length) out.push('at least 1 step required');
  if (w.steps.length > 20) out.push('max 20 steps');
  const ids = new Set<string>();
  const phases = new Set<string>();
  for (const s of w.steps ?? []) {
    if (!s.id) out.push('step id required');
    if (ids.has(s.id)) out.push(`duplicate step id "${s.id}"`);
    ids.add(s.id);
    if (s.phase) phases.add(s.phase);
    for (const d of s.depends_on) {
      if (!ids.has(d) && !w.steps.some((x) => x.id === d)) {
        out.push(`step "${s.id}" depends on unknown "${d}"`);
      }
    }
  }
  // Auto-classifier means missing phases default — still warn so seller is aware.
  if (!phases.has('capture') && !w.steps.some((s) => s.depends_on.length === 0)) {
    out.push('missing capture phase (no root step)');
  }
  if (!phases.has('express') && !w.steps.some((s) => !w.steps.some((x) => x.depends_on.includes(s.id)))) {
    out.push('missing express phase (no terminal step)');
  }
  // Cheap cycle check via toposort.
  const indeg = new Map<string, number>();
  const downs = new Map<string, string[]>();
  for (const s of w.steps ?? []) {
    indeg.set(s.id, s.depends_on.length);
    for (const d of s.depends_on) {
      const arr = downs.get(d) ?? [];
      arr.push(s.id);
      downs.set(d, arr);
    }
  }
  const q = [...indeg.entries()].filter(([, n]) => n === 0).map(([id]) => id);
  let visited = 0;
  while (q.length) {
    const id = q.shift()!;
    visited += 1;
    for (const c of downs.get(id) ?? []) {
      const n = (indeg.get(c) ?? 0) - 1;
      indeg.set(c, n);
      if (n === 0) q.push(c);
    }
  }
  if (visited !== (w.steps?.length ?? 0)) out.push('graph has a cycle');
  return out;
}

// ─── Tiny Field helper ────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="font-mono text-[10px] uppercase tracking-wide text-on-surface-variant">{label}</span>
      {children}
    </label>
  );
}


// ─── PRD-S — Quick build (AI synth) panel ───────────────────────────

const QB_CATEGORIES = [
  { id: 'research',    label: 'Research' },
  { id: 'writing',     label: 'Writing' },
  { id: 'translation', label: 'Translation' },
  { id: 'code',        label: 'Code' },
  { id: 'analysis',    label: 'Analysis' },
  { id: 'other',       label: 'Other' },
] as const;

type QbCategory = typeof QB_CATEGORIES[number]['id'];

function QuickBuildPanel({
  agentId,
  onGenerated,
}: {
  agentId: string;
  onGenerated: (synth: { workflow: WorkflowYaml; reasoning: string; inferred_category: string }) => void;
}) {
  const account = useCurrentAccount();
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<QbCategory | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reasoning, setReasoning] = useState<string | null>(null);

  const generate = async () => {
    if (!account?.address) {
      setError('connect wallet first');
      return;
    }
    if (description.trim().length < 1) {
      setError('describe your service in plain English');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api.synthesizeWorkflow(account.address, agentId, {
        description: description.trim(),
        category: category ?? undefined,
      });
      setReasoning(r.reasoning);
      onGenerated(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const charCount = description.length;
  const overLimit = charCount > 500;

  return (
    <div className="space-y-3 rounded-xl border border-primary/30 bg-primary/5 p-5">
      <div className="flex items-center gap-2">
        <span className="material-symbols-outlined text-primary">auto_awesome</span>
        <h2 className="font-mono text-sm uppercase tracking-wide text-primary">
          Quick build (AI)
        </h2>
        <span className="ml-auto font-mono text-[10px] text-on-surface-variant">
          deterministic templates · v1.1
        </span>
      </div>

      <label className="block space-y-1">
        <span className="font-mono text-[10px] uppercase tracking-wide text-on-surface-variant">
          Describe your service in plain English ({charCount}/500)
        </span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value.slice(0, 500))}
          rows={3}
          placeholder="e.g. I research the Vietnam EV market every morning and post a Twitter thread + LinkedIn post summarizing what changed."
          className={`w-full rounded-md bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary ${overLimit ? 'border border-error/40' : ''}`}
        />
      </label>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[10px] uppercase text-on-surface-variant">Category:</span>
        {QB_CATEGORIES.map((c) => {
          const active = category === c.id;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => setCategory(active ? null : c.id)}
              className={`rounded-full border px-2 py-0.5 font-mono text-[10px] ${
                active
                  ? 'border-primary bg-primary/15 text-primary'
                  : 'border-outline-variant/40 bg-surface text-on-surface-variant hover:bg-on-surface/5'
              }`}
            >
              {c.label}
            </button>
          );
        })}
        <span className="ml-1 font-mono text-[10px] text-on-surface-variant/70">
          (auto-detected if blank)
        </span>
      </div>

      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={generate}
          disabled={busy || description.trim().length === 0 || !account?.address}
          className="rounded-full bg-primary px-4 py-2 text-sm text-on-primary disabled:opacity-40"
        >
          {busy ? 'Generating…' : '✨ Generate workflow'}
        </button>
        {reasoning && (
          <span className="text-[10px] text-on-surface-variant">{reasoning}</span>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-error/40 bg-error/10 p-2 text-xs text-error">{error}</div>
      )}
    </div>
  );
}
