-- 033_workflow_v1.sql — PRD-W "Workflow v1" glue migration.
--
-- Combines the additive schema chunks from sub-PRDs W3 (memory) + W4 (outcome
-- settlement) + W6 (seller namespace delegate keys). This is the SINGLE
-- migration the PRD-W master flag (`FEATURE_LOOP_WORKFLOW_V1`) gates against.
--
-- Design invariants (PRD-W master rules):
--   • Additive only — no DROP, no destructive ALTER on existing columns.
--     Byte-identical rollback is achieved by flipping FEATURE_LOOP_WORKFLOW_V1
--     off; the schema stays applied. Full-revert paths (DROP …) are listed
--     in the trailing comment block, callable manually if ever needed.
--   • IF NOT EXISTS / IF EXISTS guards on every statement — re-running this
--     migration is idempotent.
--   • Canonical state still lives on Sui events + MemWal; tables here are
--     OPERATIONAL caches + audit-log extensions.

BEGIN;

-- ─────────────────────────────────────────────────────────────────
-- W6 — Seller Namespace Delegate Keys
-- ─────────────────────────────────────────────────────────────────
-- The seller-namespace role gets one row per published agent. The delegate
-- key is allowed (off-chain enforced via `cog_namespace_pattern` + the runtime
-- guard `isCogNamespaceForAgent`) to write only to that agent's L2-L5
-- cognitive namespaces. On-chain it has full MemWalAccount delegate authority;
-- the OpenX runner is the trust boundary.

-- 017's column `role VARCHAR(16)` already fits 'seller-namespace' (16 chars).
-- New role values (`seller-namespace`, `runner-attestation` reserved for PRD-Y)
-- are valid because the column is a free-form VARCHAR — no enum / no CHECK.

-- The existing label cap (VARCHAR(64)) is too narrow for the structured label
-- `seller-namespace::{0x...64-char-agent-id}` (= 84 chars). Widen to 128.
ALTER TABLE memwal_delegate_keys
  ALTER COLUMN label TYPE VARCHAR(128);

ALTER TABLE memwal_delegate_keys
  ADD COLUMN IF NOT EXISTS agent_id              VARCHAR(66);

ALTER TABLE memwal_delegate_keys
  ADD COLUMN IF NOT EXISTS cog_namespace_pattern VARCHAR(128);

-- Hot-path lookup: every cognitive memory write resolves the per-agent
-- delegate row by `(agent_id, role='seller-namespace')`. Partial index
-- restricted to active rows keeps the index small; one row per active agent.
CREATE INDEX IF NOT EXISTS idx_memwal_delegate_seller_active
  ON memwal_delegate_keys(agent_id)
  WHERE role = 'seller-namespace' AND revoked_at IS NULL;


-- ─────────────────────────────────────────────────────────────────
-- W3 — Stratified Memory L1-L5 (extends 031_agent_training_events)
-- ─────────────────────────────────────────────────────────────────
-- 031's CHECK on event_type already accepts 'upload', 'remember', 'reflect'.
-- W3 adds buyer-side reflections + W6 adds persona-rewrite-proposed events.
-- We can't ALTER an existing CHECK in a backward-compatible way without a
-- rewrite, but we CAN drop the constraint by name and re-add the wider one
-- in one transaction. The constraint name from 031 is `agent_training_events_event_type_check`
-- (Postgres default). If the existing 031 didn't add a CHECK at all, the
-- DROP is a no-op via IF EXISTS.

ALTER TABLE agent_training_events
  DROP CONSTRAINT IF EXISTS agent_training_events_event_type_check;

ALTER TABLE agent_training_events
  ADD CONSTRAINT agent_training_events_event_type_check
  CHECK (event_type IN (
    -- Legacy (PRD-F, 031):
    'upload', 'remember', 'reflect',
    -- W2/W3 phase events (per workflow step):
    'plan', 'execute', 'step_complete', 'workflow_complete',
    -- W3 buyer-side reflective:
    'buyer_reflection',
    -- W3 persona auto-rewrite cron:
    'persona_rewrite_proposed', 'persona_rewrite_approved', 'persona_rewrite_rejected'
  ));


-- ─────────────────────────────────────────────────────────────────
-- W4 — Outcome-priced settlement metrics
-- ─────────────────────────────────────────────────────────────────
-- Operational metrics table. The W1 stop-condition predicate type
-- `metric-threshold` reads from this table at evaluation time. Canonical
-- metrics still come from Sui events + Walrus blobs; this table is a fast
-- cache for predicate evaluation only.

CREATE TABLE IF NOT EXISTS workflow_run_metrics (
  id            BIGSERIAL PRIMARY KEY,
  job_id        VARCHAR(66)  NOT NULL,            -- LoopJob<T> shared object id
  metric_name   VARCHAR(128) NOT NULL,            -- e.g. 'twitter_unique_impressions'
  metric_value  NUMERIC(38, 0) NOT NULL,          -- integer-valued; FP avoided
  metric_source VARCHAR(64)  NOT NULL,            -- 'internal' | 'twitter' | ...
  recorded_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workflow_run_metrics_job_name
  ON workflow_run_metrics(job_id, metric_name, recorded_at DESC);


-- ─────────────────────────────────────────────────────────────────
-- W2 — Workflow run operational metadata (NOT canonical state)
-- ─────────────────────────────────────────────────────────────────
-- Canonical state for a workflow run lives on Sui events + Walrus blobs.
-- This table is a fast lookup cache by `workflow_walrus_blob_id` hash so the
-- dispatcher doesn't have to re-fetch + re-parse YAML every poll.

CREATE TABLE IF NOT EXISTS workflow_runs (
  id                          BIGSERIAL PRIMARY KEY,
  job_id                      VARCHAR(66)  NOT NULL UNIQUE,
  agent_id                    VARCHAR(66)  NOT NULL,
  buyer_addr                  VARCHAR(66)  NOT NULL,
  workflow_walrus_blob_id     VARCHAR(128),
  stop_condition_walrus_blob_id VARCHAR(128),
  outcome_pricing             BOOLEAN      NOT NULL DEFAULT false,
  status                      VARCHAR(24)  NOT NULL DEFAULT 'RUNNING',
  completed_step_count        INTEGER      NOT NULL DEFAULT 0,
  total_step_count            INTEGER      NOT NULL DEFAULT 0,
  budget_micro                BIGINT       NOT NULL DEFAULT 0,
  spent_micro                 BIGINT       NOT NULL DEFAULT 0,
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  completed_at                TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_buyer
  ON workflow_runs(buyer_addr, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_agent
  ON workflow_runs(agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_status
  ON workflow_runs(status)
  WHERE status IN ('RUNNING', 'PAUSED');

COMMIT;


-- ─────────────────────────────────────────────────────────────────
-- Manual full-revert (uncomment + run explicitly if needed). NOT executed
-- by the migration runner. Master flag flip is the standard rollback path.
-- ─────────────────────────────────────────────────────────────────
-- BEGIN;
--   DROP TABLE IF EXISTS workflow_runs;
--   DROP TABLE IF EXISTS workflow_run_metrics;
--
--   ALTER TABLE agent_training_events
--     DROP CONSTRAINT IF EXISTS agent_training_events_event_type_check;
--   ALTER TABLE agent_training_events
--     ADD CONSTRAINT agent_training_events_event_type_check
--     CHECK (event_type IN ('upload','remember','reflect'));  -- 031 baseline
--
--   DROP INDEX IF EXISTS idx_memwal_delegate_seller_active;
--   ALTER TABLE memwal_delegate_keys DROP COLUMN IF EXISTS cog_namespace_pattern;
--   ALTER TABLE memwal_delegate_keys DROP COLUMN IF EXISTS agent_id;
--   -- Note: label cannot be safely narrowed back to VARCHAR(64) without
--   -- truncating any seller-namespace::{long-id} values already inserted.
-- COMMIT;
