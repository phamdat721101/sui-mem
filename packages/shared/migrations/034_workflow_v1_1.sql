-- 034_workflow_v1_1.sql — PRD-W v1.1 FINAL amendment.
--
-- Stacks on top of 033 (W2/W3/W4/W6 substrate). Adds:
--   • PARA columns on cognitive_memories (para_kind + area_slug)
--   • seller_areas table — declared Areas per agent (S1 wizard step 3)
--   • loop_subscriptions — operational cache for daily-run scheduler
--   • right_to_forget_requests — 7-day soft-delete cooling-off
--   • paid_calls.artifact_vault_namespace — pointer to buyer's vault entry
--   • cognitive_workflows.phase_enum_validated — schema version flag
--
-- Design invariants (same as 033):
--   • Additive only — IF NOT EXISTS guards everywhere.
--   • Canonical state still on Sui events + MemWal; tables here are caches.
--   • Idempotent — safe to re-run.

BEGIN;

-- ─────────────────────────────────────────────────────────────────
-- W3 v1.1 — cognitive_memories (NEW TABLE) + PARA columns
-- ─────────────────────────────────────────────────────────────────
-- The unified L2-L5 cognitive memory store for the workflow runtime.
-- L1 episodic stays in `cognitive_episodes` (Migration 006); L2 semantic
-- consolidation stays in `cognitive_facts`. This table is the L2-L5
-- workflow-aware mirror that the new memoryService writes to and that
-- the warm-context recall reads from.

CREATE TABLE IF NOT EXISTS cognitive_memories (
  id              BIGSERIAL    PRIMARY KEY,
  brain_id        VARCHAR(66)  NOT NULL,            -- Sui object id of the agent
  namespace       VARCHAR(160) NOT NULL,            -- e.g. cog-l4-{agent}-{buyer}
  text            TEXT         NOT NULL,
  cognitive_level INTEGER      NOT NULL CHECK (cognitive_level BETWEEN 1 AND 5),
  para_kind       VARCHAR(16),                      -- nullable; v1.1 PARA tag
  area_slug       VARCHAR(64),                      -- nullable; v1.1 PARA area
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cognitive_memories_brain_ns
  ON cognitive_memories(brain_id, namespace);

CREATE INDEX IF NOT EXISTS idx_cognitive_memories_namespace_recent
  ON cognitive_memories(namespace, created_at DESC);

-- The classifier's hot path: "for this agent + buyer + area, what warm
-- context exists?" — heavily filtered by para_kind. Partial index because
-- archived rows are excluded by default.
CREATE INDEX IF NOT EXISTS idx_cognitive_memories_para_active
  ON cognitive_memories(brain_id, para_kind, area_slug)
  WHERE para_kind IN ('project', 'area', 'resource');

-- Constraint as a CHECK rather than ENUM — keeps Migration 033's "additive
-- only" discipline. DO block makes it idempotent across re-runs.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'cognitive_memories_para_kind_check'
  ) THEN
    ALTER TABLE cognitive_memories
      ADD CONSTRAINT cognitive_memories_para_kind_check
      CHECK (para_kind IS NULL OR para_kind IN ('project', 'area', 'resource', 'archive'));
  END IF;
END$$;


-- ─────────────────────────────────────────────────────────────────
-- W3 v1.1 — Seller-declared Areas (S1 wizard step 3)
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS seller_areas (
  id           BIGSERIAL    PRIMARY KEY,
  agent_id     VARCHAR(66)  NOT NULL,
  area_slug    VARCHAR(64)  NOT NULL,
  description  TEXT,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (agent_id, area_slug)
);

CREATE INDEX IF NOT EXISTS idx_seller_areas_agent
  ON seller_areas(agent_id);


-- ─────────────────────────────────────────────────────────────────
-- Daily-run subscription operational cache
-- ─────────────────────────────────────────────────────────────────
-- Canonical state lives on the LoopSubscription<T> Sui shared object.
-- This table mirrors next_run_ts for the scheduler's "due now?" sweep.

CREATE TABLE IF NOT EXISTS loop_subscriptions (
  id                       BIGSERIAL    PRIMARY KEY,
  subscription_object_id   VARCHAR(66)  NOT NULL UNIQUE,
  agent_id                 VARCHAR(66)  NOT NULL,
  buyer_addr               VARCHAR(66)  NOT NULL,
  template_walrus_blob_id  VARCHAR(128) NOT NULL,
  area_slug                VARCHAR(64),
  cron_utc_minute          INTEGER      NOT NULL,                  -- 0..1439
  runs_remaining           INTEGER      NOT NULL,
  max_per_run_micro        BIGINT       NOT NULL,
  next_run_ts              BIGINT       NOT NULL,                  -- unix ms
  last_run_ts              BIGINT,
  cancelled_at             TIMESTAMPTZ,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Hot path for scheduler.tick(): SELECT WHERE due AND active.
CREATE INDEX IF NOT EXISTS idx_loop_subscriptions_due
  ON loop_subscriptions(next_run_ts)
  WHERE cancelled_at IS NULL AND runs_remaining > 0;

CREATE INDEX IF NOT EXISTS idx_loop_subscriptions_buyer
  ON loop_subscriptions(buyer_addr, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_loop_subscriptions_agent
  ON loop_subscriptions(agent_id, created_at DESC);


-- ─────────────────────────────────────────────────────────────────
-- Right-to-forget requests (7-day soft-delete cooling-off)
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS right_to_forget_requests (
  id           BIGSERIAL    PRIMARY KEY,
  agent_id     VARCHAR(66)  NOT NULL,
  buyer_addr   VARCHAR(66)  NOT NULL,
  reason       TEXT,
  status       VARCHAR(24)  NOT NULL DEFAULT 'pending',
  requested_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  cancelled_at TIMESTAMPTZ,
  executed_at  TIMESTAMPTZ
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'right_to_forget_status_check'
  ) THEN
    ALTER TABLE right_to_forget_requests
      ADD CONSTRAINT right_to_forget_status_check
      CHECK (status IN ('pending', 'cancelled', 'executed'));
  END IF;
END$$;

-- Cron at 0500 UTC scans for status='pending' AND requested_at < now() - 7d.
CREATE INDEX IF NOT EXISTS idx_rtf_pending_due
  ON right_to_forget_requests(requested_at)
  WHERE status = 'pending';


-- ─────────────────────────────────────────────────────────────────
-- Buyer artifact vault — pointer column on paid_calls
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE paid_calls
  ADD COLUMN IF NOT EXISTS artifact_vault_namespace VARCHAR(128);


-- ─────────────────────────────────────────────────────────────────
-- W2 v1.1 — phase enum validation flag on cognitive_workflows
-- ─────────────────────────────────────────────────────────────────
-- Migration 013 already creates cognitive_workflows. v1.1 adds a flag the
-- dispatcher uses to decide whether to apply auto-classification on load.

ALTER TABLE cognitive_workflows
  ADD COLUMN IF NOT EXISTS phase_enum_validated BOOLEAN NOT NULL DEFAULT false;


-- ─────────────────────────────────────────────────────────────────
-- Persona-rewrite audit cache (drives S4 modal)
-- ─────────────────────────────────────────────────────────────────
-- The 0300 UTC cron writes here so the dashboard can render pending
-- proposals without re-fetching Walrus.

CREATE TABLE IF NOT EXISTS persona_rewrite_proposals (
  id                       BIGSERIAL    PRIMARY KEY,
  agent_id                 VARCHAR(66)  NOT NULL,
  proposed_blob_id         VARCHAR(128) NOT NULL,
  reasoning                TEXT,
  reflection_count         INTEGER      NOT NULL,
  status                   VARCHAR(16)  NOT NULL DEFAULT 'pending',
  proposed_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  resolved_at              TIMESTAMPTZ
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'persona_rewrite_status_check'
  ) THEN
    ALTER TABLE persona_rewrite_proposals
      ADD CONSTRAINT persona_rewrite_status_check
      CHECK (status IN ('pending', 'approved', 'rejected'));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_persona_proposals_agent_pending
  ON persona_rewrite_proposals(agent_id)
  WHERE status = 'pending';


COMMIT;


-- ─────────────────────────────────────────────────────────────────
-- Manual full-revert (uncomment + run explicitly).
-- ─────────────────────────────────────────────────────────────────
-- BEGIN;
--   DROP INDEX IF EXISTS idx_persona_proposals_agent_pending;
--   DROP TABLE IF EXISTS persona_rewrite_proposals;
--   ALTER TABLE cognitive_workflows DROP COLUMN IF EXISTS phase_enum_validated;
--   ALTER TABLE paid_calls DROP COLUMN IF EXISTS artifact_vault_namespace;
--   DROP INDEX IF EXISTS idx_rtf_pending_due;
--   DROP TABLE IF EXISTS right_to_forget_requests;
--   DROP INDEX IF EXISTS idx_loop_subscriptions_agent;
--   DROP INDEX IF EXISTS idx_loop_subscriptions_buyer;
--   DROP INDEX IF EXISTS idx_loop_subscriptions_due;
--   DROP TABLE IF EXISTS loop_subscriptions;
--   DROP INDEX IF EXISTS idx_seller_areas_agent;
--   DROP TABLE IF EXISTS seller_areas;
--   ALTER TABLE cognitive_memories DROP CONSTRAINT IF EXISTS cognitive_memories_para_kind_check;
--   DROP INDEX IF EXISTS idx_cognitive_memories_para_active;
--   ALTER TABLE cognitive_memories DROP COLUMN IF EXISTS area_slug;
--   ALTER TABLE cognitive_memories DROP COLUMN IF EXISTS para_kind;
-- COMMIT;
