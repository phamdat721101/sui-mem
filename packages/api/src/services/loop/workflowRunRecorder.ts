/**
 * services/loop/workflowRunRecorder.ts — single source of truth for the
 * side effects that fire after a workflow run finishes:
 *
 *   1. Insert a row into `workflow_runs`     → enables /activity timeline.
 *   2. Upload artifacts to Walrus + deposit  → enables vault + bundle ZIP.
 *   3. Record one row in `paid_calls`        → enables seller studio earnings.
 *
 * Two call sites depend on this module:
 *   - `routes/v3-loop.ts` POST /agents/:id/run-workflow (instant paid run)
 *   - `server.ts` subscription cron tick (daily-recurring forked run)
 *
 * Without this helper, both call sites would have to duplicate the same
 * 3-step write contract — a textbook DRY violation. SRP: this module owns
 * exactly the post-run write path; it does not run inference, build PTBs,
 * or talk to Sui.
 *
 * SOLID:
 *   - SRP: one function, three writes.
 *   - DIP: pool, walrus uploader, vault, ledger, logger — all injected.
 *   - OCP: a fourth side effect (e.g. analytics emit) = one new step in
 *     this single function; no caller changes.
 */

import type { Pool } from 'pg';
import type { Logger } from 'pino';
import * as ledger from '../paidCallLedger';
import { ArtifactVaultService } from './artifactVaultService';
import type { WorkflowRunResult } from './workflowDispatcher';

const NETWORK_FROM_CHAIN = (chain: string | undefined): string =>
  chain && chain.startsWith('sui') ? chain : 'sui-testnet';

export interface WalrusUploader {
  upload(bytes: Uint8Array): Promise<{ blobs: Array<{ blobId: string }> }>;
}

export interface RecorderDeps {
  pool: Pool;
  vault: ArtifactVaultService;
  walrus: WalrusUploader;
  logger: Logger;
}

export interface RecordRunInput {
  /** Result returned by `WorkflowDispatcher.run()`. */
  result: WorkflowRunResult;
  /** Agent slug or UUID — whichever the caller already has on hand. */
  agent_id: string;
  /** Agent UUID for paid_calls.agent_id (FK). Falls back to agent_id when same. */
  agent_pkid: string;
  /** Buyer 0x… wallet. */
  buyer_addr: string;
  /** Buyer-supplied request text (for the artifact name + final markdown). */
  request: string;
  /** Stable run identifier passed to the dispatcher. */
  job_id: string;
  area_slug: string | null;
  /** Walrus blob id of the workflow YAML, if known. */
  workflow_walrus_blob_id?: string | null;
  /** Settlement context. */
  payment: {
    /** USDC paid (decimal string, e.g. '0.0100'). For cron runs, '0'. */
    amount_usdc: string;
    /** On-chain tx digest, OR a synthetic id like `cron:sub-{id}-{ts}`. */
    tx_hash: string;
    /** Chain identifier — sui-mainnet | sui-testnet. */
    network?: string;
    /** Method tag for analytics. */
    method?: ledger.PaidCallMethod;
  };
}

/** Build artifacts from the dispatcher result.
 *  Keeps the artifact list small (1-3 items) so Walrus uploads stay cheap.
 *  - `final_output.md` → the express step's markdown (always present)
 *  - `workflow.json`   → per-step trace, useful for debugging + replay
 */
export function buildArtifacts(input: {
  result: WorkflowRunResult;
  request: string;
}): Array<{ name: string; bytes: Uint8Array; mime_type: string }> {
  const out: Array<{ name: string; bytes: Uint8Array; mime_type: string }> = [];

  // Final markdown — concatenate the express step's output, falling back to
  // last successful step. Mirrors the same field-fallback logic as
  // /run-workflow used for the in-modal preview.
  const express = [...input.result.per_step]
    .reverse()
    .find((s) => s.phase === 'express' && s.status === 'ok');
  const lastOk = express ?? [...input.result.per_step].reverse().find((s) => s.status === 'ok');
  const o = (lastOk?.output ?? {}) as Record<string, unknown>;
  const final_md = String(
    o.daily_post ?? o.final_output ?? o.translated ?? o.report_md ??
    o.review_md ?? o.analysis_md ?? o.result_md ?? '',
  ).trim();

  if (final_md) {
    out.push({
      name: 'final_output.md',
      bytes: new TextEncoder().encode(final_md),
      mime_type: 'text/markdown',
    });
  }

  // Trace — small JSON of (request, per-step status + outputs).
  const trace = JSON.stringify({
    request: input.request,
    steps_completed: input.result.steps_completed,
    steps_total: input.result.steps_total,
    per_step: input.result.per_step.map((s) => ({
      id: s.id, phase: s.phase, status: s.status, spent_micro: s.spent_micro,
    })),
  }, null, 2);
  out.push({
    name: 'workflow.json',
    bytes: new TextEncoder().encode(trace),
    mime_type: 'application/json',
  });

  return out;
}

/**
 * Record the post-run side effects atomically (best-effort: each side effect
 * soft-fails independently with a structured warn — no single failure blocks
 * the others or the buyer-visible response).
 */
export async function recordWorkflowRunSideEffects(
  deps: RecorderDeps,
  input: RecordRunInput,
): Promise<{ workflow_run_id: number | null; deposited: number; paid_call_recorded: boolean }> {
  // ─── 1. workflow_runs INSERT ────────────────────────────────────────
  let workflow_run_id: number | null = null;
  const spent_micro = input.result.per_step.reduce((acc, s) => acc + (s.spent_micro || 0), 0);
  const status = input.result.steps_completed === input.result.steps_total ? 'COMPLETED' : 'FAILED';
  try {
    const r = await deps.pool.query<{ id: number }>(
      `INSERT INTO workflow_runs
            (job_id, buyer_addr, agent_id, workflow_walrus_blob_id,
             status, completed_step_count, total_step_count,
             budget_micro, spent_micro, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (job_id) DO UPDATE SET
            status               = EXCLUDED.status,
            completed_step_count = EXCLUDED.completed_step_count,
            total_step_count     = EXCLUDED.total_step_count,
            spent_micro          = EXCLUDED.spent_micro,
            completed_at         = EXCLUDED.completed_at,
            updated_at           = now()
       RETURNING id`,
      [
        input.job_id,
        input.buyer_addr.toLowerCase(),
        input.agent_id,
        input.workflow_walrus_blob_id ?? null,
        status,
        input.result.steps_completed,
        input.result.steps_total,
        25_000_000,
        spent_micro,
      ],
    );
    workflow_run_id = r.rows[0]?.id ?? null;
  } catch (e) {
    deps.logger.warn(
      { err: (e as Error).message, job_id: input.job_id },
      'recorder:workflow_runs_failed',
    );
  }

  // ─── 2. Upload artifacts to Walrus + vault.deposit ─────────────────
  let deposited = 0;
  try {
    const arts = buildArtifacts({ result: input.result, request: input.request });
    const uploaded: Array<{ name: string; walrus_blob_id: string; mime_type: string; size_bytes: number }> = [];
    for (const a of arts) {
      try {
        const up = await deps.walrus.upload(a.bytes);
        const blobId = up.blobs[0]?.blobId;
        if (blobId) {
          uploaded.push({
            name: a.name,
            walrus_blob_id: blobId,
            mime_type: a.mime_type,
            size_bytes: a.bytes.length,
          });
        }
      } catch (e) {
        deps.logger.warn(
          { err: (e as Error).message, name: a.name },
          'recorder:walrus_upload_failed_continue',
        );
      }
    }
    if (uploaded.length) {
      const r = await deps.vault.deposit({
        buyer_addr: input.buyer_addr,
        area_slug: input.area_slug,
        job_id: input.job_id,
        artifacts: uploaded,
      });
      deposited = r.deposited;
    }
  } catch (e) {
    deps.logger.warn(
      { err: (e as Error).message, job_id: input.job_id },
      'recorder:vault_deposit_failed',
    );
  }

  // ─── 3. paid_calls record (seller studio earnings) ─────────────────
  let paid_call_recorded = false;
  try {
    paid_call_recorded = await ledger.record({
      agent_id: input.agent_pkid,
      slug: input.agent_id,
      buyer: input.buyer_addr,
      amount_usdc: input.payment.amount_usdc,
      tx_hash: input.payment.tx_hash,
      network: input.payment.network ?? NETWORK_FROM_CHAIN(input.payment.network),
      method: input.payment.method ?? 'sui_usdc',
    });
  } catch (e) {
    deps.logger.warn(
      { err: (e as Error).message, tx_hash: input.payment.tx_hash },
      'recorder:paid_calls_failed',
    );
  }

  deps.logger.info(
    { job_id: input.job_id, workflow_run_id, deposited, paid_call_recorded },
    'recorder:done',
  );

  return { workflow_run_id, deposited, paid_call_recorded };
}
