-- 013_workflows.sql
-- L4 Workflow primitive — additive only.
--
-- L1/L2/L3 schemas (from 006_cognitive_memory.sql) are untouched.
-- The L4 layer adds two tables:
--   cognitive_workflows        — published workflows (one per Sui Move object)
--   cognitive_workflow_runs    — per-execution receipts feeding L5 reflective
--
-- Tier-isolation (G3): every workflow row carries `sui_object_id NOT NULL`.
-- WorkflowRunner asserts this before executing — Standard-tier brains have
-- no Sui object and can never produce a workflow row.

-- ─── L4 cognitive_workflows ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cognitive_workflows (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_key        text NOT NULL,
  author_addr         text NOT NULL,
  -- Sui object id (0x… 32-byte hex). NOT NULL enforces G3 isolation.
  sui_object_id       text NOT NULL,
  -- Walrus blob holding the canonical signed DAG manifest.
  manifest_blob_id    text NOT NULL,
  name                text NOT NULL,
  description         text NOT NULL DEFAULT '',
  -- Plaintext step DAG — judges/buyers read it via /v3/workflows. Author
  -- can reveal step internals as needed (procedureRef, skillRef, brainAskRef).
  steps               jsonb NOT NULL,
  -- Schemas are public so buyers know what to send and expect.
  input_schema        jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_schema       jsonb NOT NULL DEFAULT '{}'::jsonb,
  default_price_usdc  numeric(20,6) NOT NULL,
  author_bps          int NOT NULL DEFAULT 9500,
  platform_bps        int NOT NULL DEFAULT 500,
  published           boolean NOT NULL DEFAULT false,
  kya_required        boolean NOT NULL DEFAULT false,
  min_reputation      int NOT NULL DEFAULT 0,
  signer              text NOT NULL,
  signature           text NOT NULL,
  -- Cite-to-extend: the L3 procedural ids that justified this workflow.
  derived_from        jsonb NOT NULL DEFAULT '[]'::jsonb,
  runs                int NOT NULL DEFAULT 0,
  successful_runs     int NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL DEFAULT now() + interval '180 days',
  -- bps must sum to 10000.
  CONSTRAINT cognitive_workflows_bps_check CHECK (author_bps + platform_bps = 10000)
);

CREATE UNIQUE INDEX IF NOT EXISTS cognitive_workflows_author_key_uniq
  ON cognitive_workflows (author_addr, workflow_key);
CREATE UNIQUE INDEX IF NOT EXISTS cognitive_workflows_sui_object_uniq
  ON cognitive_workflows (sui_object_id);
CREATE INDEX IF NOT EXISTS cognitive_workflows_published_idx
  ON cognitive_workflows (published, created_at DESC) WHERE published;
CREATE INDEX IF NOT EXISTS cognitive_workflows_expires_idx
  ON cognitive_workflows (expires_at);

-- ─── L4 cognitive_workflow_runs ─────────────────────────────────────────────
-- One row per execution. Feeds L5 reflective promotion (≥3 success + ≥1 fail).
CREATE TABLE IF NOT EXISTS cognitive_workflow_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id         uuid NOT NULL REFERENCES cognitive_workflows(id) ON DELETE CASCADE,
  workflow_key        text NOT NULL,
  buyer               text NOT NULL,
  -- sha256(canonical(input)) — used to fingerprint inputs without exposing them.
  input_fingerprint   text NOT NULL,
  success             boolean NOT NULL,
  -- Per-step receipts: array of WorkflowStepReceipt JSON.
  step_receipts       jsonb NOT NULL DEFAULT '[]'::jsonb,
  outputs_hash        text NOT NULL,
  total_usdc          numeric(20,6) NOT NULL,
  -- Phala TEE attestation hash for the overall run (optional).
  attestation_hash    text,
  -- 0..100; from TEE judge or human eval; null until rated.
  quality_score       int,
  started_at          timestamptz NOT NULL,
  ended_at            timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cognitive_workflow_runs_workflow_idx
  ON cognitive_workflow_runs (workflow_id, created_at DESC);
CREATE INDEX IF NOT EXISTS cognitive_workflow_runs_buyer_idx
  ON cognitive_workflow_runs (buyer, created_at DESC);
CREATE INDEX IF NOT EXISTS cognitive_workflow_runs_success_idx
  ON cognitive_workflow_runs (workflow_id, success, created_at DESC);
