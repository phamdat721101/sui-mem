-- Migration 037 — agent_events indexer table + cursor.
--
-- Receives every event emitted by `openx_loop_agent_registry` Move module
-- (LoopAgentPublished, AgentPublishFeePaid, AgentPricingUpdated,
-- AgentModelUpdated, AgentManifestUpdated, AgentManifestAttested,
-- LoopAgentRevoked, BedrockModelWhitelisted, BedrockModelDelisted,
-- LoopAgentReputationUpdated). Idempotent on (tx_digest, seq_in_tx).
--
-- The cursor is a single-row table that the indexer cron updates atomically
-- after each successful poll batch. Letting the indexer crash mid-batch
-- and re-poll is safe because of the UNIQUE constraint.

BEGIN;

CREATE TABLE IF NOT EXISTS agent_events (
  id              BIGSERIAL PRIMARY KEY,
  agent_object_id TEXT,                         -- nullable: registry-level events
  seller_addr     TEXT,                         -- nullable: registry-level events
  event_type      TEXT       NOT NULL,
  tx_digest       TEXT       NOT NULL,
  seq_in_tx       INT        NOT NULL DEFAULT 0,
  payload         JSONB      NOT NULL DEFAULT '{}'::jsonb,
  timestamp_ms    BIGINT     NOT NULL,
  indexed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tx_digest, seq_in_tx)
);

CREATE INDEX IF NOT EXISTS idx_agent_events_agent_ts
  ON agent_events (agent_object_id, timestamp_ms DESC)
  WHERE agent_object_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_events_seller_ts
  ON agent_events (seller_addr, timestamp_ms DESC)
  WHERE seller_addr IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_events_type_ts
  ON agent_events (event_type, timestamp_ms DESC);

CREATE TABLE IF NOT EXISTS agent_events_cursor (
  id              SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  cursor_json     JSONB,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO agent_events_cursor (id, cursor_json) VALUES (1, NULL)
  ON CONFLICT (id) DO NOTHING;

COMMIT;
