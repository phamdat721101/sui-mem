-- Migration 035 — workflow_run_artifacts view + supporting JSON-path index.
--
-- Purpose: a single SQL source of truth for the per-run timeline panel.
-- Joins existing `cognitive_memories` (artifact manifests deposited by
-- `artifactVaultService.deposit()`) with `workflow_runs` (per-run status
-- shipped in migration 033) on the JSON `job_id` field.
--
-- Schema notes (matches deployed 033/034):
--   workflow_runs uses: status enum (RUNNING|PAUSED|COMPLETED|FAILED),
--   completed_step_count, spent_micro, created_at, completed_at.
--   The view aliases these to the names the API/UI expect for stable
--   contracts (run_started_at, total_cost_micro, step_count,
--   outcome_satisfied derived, run_status normalized to lowercase).
--
-- No new tables. Idempotent.

BEGIN;

CREATE OR REPLACE VIEW workflow_run_artifacts AS
SELECT
  cm.text::jsonb ->> 'job_id'                            AS job_id,
  cm.text::jsonb ->> 'area_slug'                         AS area_slug,
  cm.text::jsonb ->> 'artifact_name'                     AS artifact_name,
  cm.text::jsonb ->> 'walrus_blob_id'                    AS walrus_blob_id,
  cm.text::jsonb ->> 'mime_type'                         AS mime_type,
  COALESCE((cm.text::jsonb ->> 'size_bytes')::int, 0)    AS size_bytes,
  cm.namespace                                           AS namespace,
  cm.brain_id                                            AS buyer_addr,
  cm.created_at                                          AS artifact_created_at,
  CASE
    WHEN wr.status = 'COMPLETED' THEN TRUE
    WHEN wr.status = 'FAILED'    THEN FALSE
    ELSE NULL
  END                                                    AS outcome_satisfied,
  wr.spent_micro                                         AS total_cost_micro,
  wr.completed_step_count                                AS step_count,
  wr.workflow_walrus_blob_id                             AS workflow_walrus_blob_id,
  wr.created_at                                          AS run_started_at,
  wr.completed_at                                        AS run_completed_at,
  wr.agent_id                                            AS agent_id,
  CASE
    WHEN wr.status = 'COMPLETED' THEN 'success'
    WHEN wr.status = 'FAILED'    THEN 'failed'
    WHEN wr.status = 'RUNNING'   THEN 'running'
    WHEN wr.status = 'PAUSED'    THEN 'pending'
    WHEN wr.status IS NULL       THEN 'pending'
    ELSE lower(wr.status)
  END                                                    AS run_status
FROM cognitive_memories cm
LEFT JOIN workflow_runs wr
  ON wr.job_id = cm.text::jsonb ->> 'job_id'
WHERE cm.cognitive_level = 4
  AND cm.namespace LIKE 'artifact-vault-%';

-- Supporting partial index for the JSON-path lookup; idempotent.
CREATE INDEX IF NOT EXISTS idx_cm_artifact_vault_job_id
  ON cognitive_memories ((text::jsonb ->> 'job_id'))
  WHERE namespace LIKE 'artifact-vault-%';

COMMIT;
