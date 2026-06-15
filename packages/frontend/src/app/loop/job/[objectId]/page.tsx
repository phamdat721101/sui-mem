'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useSuiClient } from '@mysten/dapp-kit';
import { useSealJobResults } from '@/hooks/useSealJobResults';

interface IterResult {
  iter_n: string;
  walrus_blob_id: string;
  attestation_hash: number[];
  ts_ms: string;
}

interface JobFields {
  buyer: string;
  agent_id: string;
  manifest_walrus_blob_id: string;
  status: number;
  iterations_done: string;
  max_iterations: string;
  spent_micro: string;
  budget_micro: string;
  iter_results: IterResult[];
}

const STATUS = ['Running', 'Paused (budget)', 'Paused (checkpoint)', 'Done', 'Cancelled'];

export default function LoopJobDashboardPage() {
  const params = useParams<{ objectId: string }>();
  const client = useSuiClient();
  const [job, setJob] = useState<JobFields | null>(null);
  const [decrypted, setDecrypted] = useState<Record<string, string>>({});
  const { decrypt, busy } = useSealJobResults();

  useEffect(() => {
    if (!params?.objectId) return;
    const tick = async () => {
      const r = await client.getObject({ id: params.objectId, options: { showContent: true } });
      const c = r.data?.content;
      if (c?.dataType === 'moveObject') setJob((c.fields as unknown) as JobFields);
    };
    tick();
    const t = setInterval(tick, 5_000);
    return () => clearInterval(t);
  }, [params?.objectId, client]);

  if (!job) return <div className="text-on-surface-variant">Loading job…</div>;

  const onDecrypt = async (iter: IterResult) => {
    // Mode-B sealed key + iv arrive off-chain; in v0.0 the runner returns them
    // in the iter receipt event. The dashboard fetches them via API by jobId+iterN.
    // For the v0.0 simple ship, we link out to the API endpoint where the
    // buyer can pull the bundle. Full inline decrypt UI lands in v0.1.
    const url = `/api/v1/loop/job/${params?.objectId}/iter/${iter.iter_n}`;
    setDecrypted((d) => ({ ...d, [iter.iter_n]: `Open: ${url}` }));
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="space-y-2">
        <span className="font-mono text-[11px] text-on-surface-variant">
          {params?.objectId?.slice(0, 12)}…{params?.objectId?.slice(-6)}
        </span>
        <h1 className="font-headline text-3xl font-bold">Loop Job</h1>
        <div className="flex flex-wrap gap-2 text-xs">
          <Pill>{STATUS[job.status] ?? `status ${job.status}`}</Pill>
          <Pill>
            iter {job.iterations_done} / {job.max_iterations}
          </Pill>
          <Pill>
            spent {(Number(job.spent_micro) / 1_000_000).toFixed(4)} / {(Number(job.budget_micro) / 1_000_000).toFixed(4)} USDC
          </Pill>
        </div>
      </header>

      <section className="space-y-3">
        <h2 className="font-headline text-base font-semibold">Iter timeline</h2>
        {job.iter_results.length === 0 && (
          <div className="rounded-md border border-outline-variant/30 bg-surface p-3 text-sm text-on-surface-variant">
            No iters yet — runner has not advanced.
          </div>
        )}
        {job.iter_results.map((iter) => (
          <div key={iter.iter_n} className="rounded-md border border-outline-variant/30 bg-surface p-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono">#iter {iter.iter_n}</span>
              <span className="font-mono text-[11px] text-on-surface-variant">
                blob {iter.walrus_blob_id.slice(0, 10)}…
              </span>
              <button
                type="button"
                onClick={() => onDecrypt(iter)}
                disabled={busy}
                className="rounded-full bg-primary/20 px-3 py-1 text-[11px] font-mono text-primary disabled:opacity-40"
              >
                {decrypted[iter.iter_n] ? 'Ready' : 'Decrypt'}
              </button>
            </div>
            {decrypted[iter.iter_n] && (
              <div className="mt-2 break-all rounded bg-surface-container-low p-2 font-mono text-[11px] text-on-surface">
                {decrypted[iter.iter_n]}
              </div>
            )}
          </div>
        ))}
      </section>

      <p className="text-xs text-on-surface-variant">
        Auto-refreshes every 5 s. Pause / resume / cancel buttons land in v0.1 — the Move primitives
        already exist (`openx_loop_job::pause/resume/cancel`).
      </p>
    </div>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-outline-variant/40 bg-surface-container-high px-2 py-0.5 font-mono text-[10px] text-on-surface-variant">
      {children}
    </span>
  );
}
