-- 038_loop_subscriptions_escrow_v2.sql
-- Adds 3 columns + refines the partial index for the new escrow flow.
--
-- PRD `workflow-escrow` (decision 1=b: sibling package fhe_brain_loop_v2):
--   • package_version          — 1 = legacy LoopSubscription, 2 = v2 WorkflowEscrow.
--   • escrow_remaining_micro   — live Balance<T> mirror; cron uses this to skip stopped.
--   • total_escrowed_micro     — cumulative (initial + every top_up); seller-view.
--
-- Migration is additive + idempotent. Existing rows default to package_version=1
-- and escrow_remaining_micro=runs_remaining*max_per_run_micro (back-fill computed
-- only for rows that haven't been refunded). No back-fill is required for
-- correctness — the indexer overwrites these fields on every event.

ALTER TABLE loop_subscriptions
  ADD COLUMN IF NOT EXISTS package_version       SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS escrow_remaining_micro BIGINT  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_escrowed_micro   BIGINT  NOT NULL DEFAULT 0;

-- Best-effort back-fill of legacy rows so their UI status doesn't flip to
-- "stopped" the first time the new build hits the API. Idempotent — only
-- touches rows that still look unrefunded.
UPDATE loop_subscriptions
   SET escrow_remaining_micro =
         GREATEST(0, runs_remaining)::BIGINT * max_per_run_micro,
       total_escrowed_micro =
         GREATEST(0, runs_remaining)::BIGINT * max_per_run_micro
 WHERE escrow_remaining_micro = 0
   AND total_escrowed_micro = 0
   AND cancelled_at IS NULL;

-- Refine the cron's hot-path partial index so the scheduler skips stopped
-- escrows (escrow_remaining < max_per_run) without a JS pass. We keep the
-- old index name to not break any external monitoring.
DROP INDEX IF EXISTS idx_loop_subscriptions_due;
CREATE INDEX IF NOT EXISTS idx_loop_subscriptions_due
  ON loop_subscriptions(next_run_ts)
  WHERE cancelled_at IS NULL
    AND runs_remaining > 0
    AND escrow_remaining_micro >= max_per_run_micro;
