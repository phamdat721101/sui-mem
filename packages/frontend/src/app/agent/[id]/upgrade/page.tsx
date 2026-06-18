'use client';

/**
 * /loop/seller/agent/[id]/upgrade — opt-in seller upgrade wizard (PRD-W v1.1).
 *
 * 3-step migration UX for an existing agent → workflow-aware brain:
 *   Step 1: Migration preview — classifier dry-run distribution + 50-row sample
 *   Step 2: Declare PARA Areas — slug + description list
 *   Step 3: Confirm + sign — POSTs to /v3/loop/seller/agents/:id/upgrade
 *
 * SOLID:
 *   - SRP: presentation + 3-step orchestration. All classification + DB writes
 *     live behind the api.ts helpers (`upgradePreview` + `upgradeAgent`).
 *   - DIP: page depends on `api` from `@/lib/api`, never on raw fetch.
 */

import { useEffect, useState } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit';
import { useParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api';

type ParaKind = 'project' | 'area' | 'resource' | 'archive';

interface PreviewState {
  distribution: Record<ParaKind, number>;
  sample: Array<{
    id: number; namespace: string;
    predicted: { para_kind: string; area_slug: string | null };
    created_at: string;
  }>;
}

interface AreaInput {
  slug: string;
  description: string;
}

const STEP_LABELS = ['Preview', 'Declare Areas', 'Confirm + sign'] as const;
const DEFAULT_AREAS: AreaInput[] = [{ slug: '', description: '' }];

export default function AgentUpgradeWizardPage() {
  const params = useParams<{ id: string }>();
  const agentId = params?.id ?? '';
  const account = useCurrentAccount();
  const router = useRouter();

  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [areas, setAreas] = useState<AreaInput[]>(DEFAULT_AREAS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Step 1 — load preview as soon as wallet is connected.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!account?.address || !agentId) return;
      setBusy(true);
      setError(null);
      try {
        const r = await api.upgradePreview(account.address, agentId);
        if (!cancelled) setPreview(r);
      } catch (e) {
        if (!cancelled) setError(`preview failed: ${(e as Error).message}`);
      } finally {
        if (!cancelled) setBusy(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [account?.address, agentId]);

  const addArea = () => setAreas((a) => [...a, { slug: '', description: '' }]);
  const removeArea = (idx: number) => setAreas((a) => a.filter((_, i) => i !== idx));
  const updateArea = (idx: number, k: keyof AreaInput, v: string) =>
    setAreas((a) => a.map((x, i) => (i === idx ? { ...x, [k]: v } : x)));

  const submit = async () => {
    if (!account?.address) {
      setError('Connect a Sui wallet first');
      return;
    }
    const validAreas = areas.map((a) => a.slug.trim()).filter((s) => s.length > 0).slice(0, 16);
    if (validAreas.length === 0) {
      setError('Declare at least 1 PARA Area');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.upgradeAgent(account.address, agentId, {
        // For v1.1 ship gate: workflow_walrus_blob_id is captured from the
        // agent's existing manifest_walrus_blob_id (read on the server side
        // when the chain PTB lands). The frontend just declares areas + intent.
        workflow_walrus_blob_id: 'pending-on-chain-ptb',
        area_slugs: validAreas,
      });
      setDone(true);
    } catch (e) {
      setError(`upgrade failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  if (!account?.address) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <h1 className="font-headline text-2xl font-bold">Upgrade agent to workflow-aware brain</h1>
        <p className="mt-3 text-on-surface-variant">Connect a Sui wallet to load the migration preview.</p>
      </div>
    );
  }

  if (done) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <h1 className="font-headline text-2xl font-bold">✓ Upgrade staged</h1>
        <p className="mt-3 text-on-surface-variant">
          Your agent is now PARA-aware. Workflow runs will tag past engagements; nightly
          persona-rewrite + archival crons activate after the master flag flips.
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => router.push(`/agent/${agentId}/workflow`)}
            className="rounded-full bg-primary px-4 py-2 text-sm text-on-primary"
          >
            Edit workflow YAML →
          </button>
          <button
            type="button"
            onClick={() => router.push(`/agent/${agentId}`)}
            className="rounded-full border border-outline-variant/40 px-4 py-2 text-sm text-on-surface-variant hover:bg-on-surface/5"
          >
            Back to agent
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <header className="space-y-2">
        <h1 className="font-headline text-3xl font-bold">Upgrade to workflow-aware brain</h1>
        <p className="text-sm text-on-surface-variant font-mono">Agent: {agentId}</p>
        <Stepper step={step} />
      </header>

      {error && (
        <div className="rounded-lg border border-error/40 bg-error/10 p-3 text-sm text-error">{error}</div>
      )}

      {step === 0 && (
        <PreviewPanel
          preview={preview}
          busy={busy}
          onContinue={() => setStep(1)}
        />
      )}

      {step === 1 && (
        <AreasPanel
          areas={areas}
          onAdd={addArea}
          onRemove={removeArea}
          onUpdate={updateArea}
          onBack={() => setStep(0)}
          onContinue={() => setStep(2)}
        />
      )}

      {step === 2 && (
        <ConfirmPanel
          areas={areas}
          preview={preview}
          busy={busy}
          onBack={() => setStep(1)}
          onSubmit={submit}
        />
      )}
    </div>
  );
}

function Stepper({ step }: { step: 0 | 1 | 2 }) {
  return (
    <ol className="flex gap-2 text-xs font-mono uppercase tracking-wide">
      {STEP_LABELS.map((label, i) => (
        <li
          key={label}
          className={
            i === step
              ? 'rounded-full bg-primary/15 px-3 py-1 text-primary'
              : i < step
                ? 'rounded-full bg-on-surface/10 px-3 py-1 text-on-surface'
                : 'rounded-full px-3 py-1 text-on-surface-variant'
          }
        >
          {i + 1}. {label}
        </li>
      ))}
    </ol>
  );
}

function PreviewPanel({
  preview, busy, onContinue,
}: { preview: PreviewState | null; busy: boolean; onContinue: () => void }) {
  return (
    <div className="space-y-4 rounded-xl border border-outline-variant/30 bg-surface p-5">
      <h2 className="font-mono text-lg uppercase tracking-wide text-on-surface">Migration preview</h2>
      <p className="text-sm text-on-surface-variant">
        Auto-classification of your past memory rows. Reversible until you sign — agents not
        upgraded continue working byte-identically.
      </p>
      {busy && <div className="text-sm text-on-surface-variant">Loading…</div>}
      {preview && (
        <>
          <div className="grid grid-cols-4 gap-3">
            {(['project', 'area', 'resource', 'archive'] as const).map((k) => (
              <div key={k} className="rounded-lg border border-outline-variant/20 bg-surface-container-low p-3 text-center">
                <div className="text-2xl font-bold text-on-surface">{preview.distribution[k]}</div>
                <div className="font-mono text-xs uppercase text-on-surface-variant">{k}</div>
              </div>
            ))}
          </div>
          {preview.sample.length > 0 && (
            <div className="max-h-64 overflow-y-auto rounded-lg border border-outline-variant/20">
              <table className="w-full text-xs">
                <thead className="bg-surface-container-low text-left">
                  <tr>
                    <th className="px-2 py-1 font-mono uppercase">Namespace</th>
                    <th className="px-2 py-1 font-mono uppercase">Predicted</th>
                    <th className="px-2 py-1 font-mono uppercase">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.sample.slice(0, 12).map((row) => (
                    <tr key={row.id} className="border-t border-outline-variant/20">
                      <td className="px-2 py-1 font-mono text-on-surface-variant">{row.namespace.slice(0, 36)}…</td>
                      <td className="px-2 py-1">
                        <span className="rounded bg-primary/15 px-1.5 py-0.5 font-mono text-primary">{row.predicted.para_kind}</span>
                      </td>
                      <td className="px-2 py-1 text-on-surface-variant">{row.created_at.slice(0, 10)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onContinue}
          disabled={busy || !preview}
          className="rounded-full bg-primary px-4 py-2 text-sm text-on-primary disabled:opacity-40"
        >
          Continue →
        </button>
      </div>
    </div>
  );
}

function AreasPanel({
  areas, onAdd, onRemove, onUpdate, onBack, onContinue,
}: {
  areas: AreaInput[];
  onAdd: () => void;
  onRemove: (i: number) => void;
  onUpdate: (i: number, k: keyof AreaInput, v: string) => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  return (
    <div className="space-y-4 rounded-xl border border-outline-variant/30 bg-surface p-5">
      <div>
        <h2 className="font-mono text-lg uppercase tracking-wide text-on-surface">Declare PARA Areas</h2>
        <p className="text-sm text-on-surface-variant">
          Each Area = a context boundary the agent's brain uses for warm-context recall.
          Buyers filter agents by Area. Recommend 3-8 for discoverability.
        </p>
      </div>
      <div className="space-y-2">
        {areas.map((a, i) => (
          <div key={i} className="flex gap-2">
            <input
              value={a.slug}
              onChange={(e) => onUpdate(i, 'slug', e.target.value)}
              placeholder="vietnam-content"
              className="w-40 rounded-md bg-surface-container-low px-3 py-2 font-mono text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <input
              value={a.description}
              onChange={(e) => onUpdate(i, 'description', e.target.value)}
              placeholder="VN-language tech writing"
              className="flex-1 rounded-md bg-surface-container-low px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            />
            {areas.length > 1 && (
              <button
                type="button"
                onClick={() => onRemove(i)}
                className="rounded-md px-2 py-1 text-sm text-on-surface-variant hover:bg-error/10 hover:text-error"
                aria-label="remove"
              >
                ✕
              </button>
            )}
          </div>
        ))}
        <button
          type="button"
          onClick={onAdd}
          className="rounded-md border border-outline-variant/40 px-3 py-1 text-sm text-on-surface-variant hover:bg-on-surface/5"
        >
          + Add Area
        </button>
      </div>
      <div className="flex justify-between">
        <button type="button" onClick={onBack} className="rounded-full px-4 py-2 text-sm text-on-surface-variant">
          ← Back
        </button>
        <button
          type="button"
          onClick={onContinue}
          className="rounded-full bg-primary px-4 py-2 text-sm text-on-primary"
        >
          Continue →
        </button>
      </div>
    </div>
  );
}

function ConfirmPanel({
  areas, preview, busy, onBack, onSubmit,
}: {
  areas: AreaInput[];
  preview: PreviewState | null;
  busy: boolean;
  onBack: () => void;
  onSubmit: () => void;
}) {
  const validAreas = areas.map((a) => a.slug.trim()).filter((s) => s.length > 0);
  const distribution = preview?.distribution;
  return (
    <div className="space-y-4 rounded-xl border border-outline-variant/30 bg-surface p-5">
      <h2 className="font-mono text-lg uppercase tracking-wide text-on-surface">Confirm + sign</h2>
      <ul className="space-y-1 text-sm text-on-surface">
        <li>
          • <span className="font-mono text-on-surface-variant">{validAreas.length}</span> Areas declared:
          {' '}
          {validAreas.map((s) => <span key={s} className="ml-1 rounded bg-primary/15 px-1.5 py-0.5 font-mono text-primary">{s}</span>)}
        </li>
        {distribution && (
          <li>
            • Past memory:
            {' '}
            <span className="font-mono">{distribution.project}</span> projects ·{' '}
            <span className="font-mono">{distribution.area}</span> areas ·{' '}
            <span className="font-mono">{distribution.resource}</span> resources ·{' '}
            <span className="font-mono">{distribution.archive}</span> archives
          </li>
        )}
        <li>• Existing agent stays callable; new buyers get workflow-aware brain on their first hire.</li>
      </ul>
      <div className="flex justify-between">
        <button type="button" onClick={onBack} className="rounded-full px-4 py-2 text-sm text-on-surface-variant">
          ← Back
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={busy || validAreas.length === 0}
          className="rounded-full bg-primary px-4 py-2 text-sm text-on-primary disabled:opacity-40"
        >
          {busy ? 'Submitting…' : '✓ Sign + upgrade'}
        </button>
      </div>
    </div>
  );
}
