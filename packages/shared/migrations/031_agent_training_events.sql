-- 031_agent_training_events.sql — per-agent training audit trail (PRD-F).
--
-- Records every seller-initiated action against a specific agent: document
-- uploads, memwal "remember" writes, and reflection-loop iterations.
-- Buyer settlements are NOT duplicated here — they come from `paid_calls`
-- and are UNION'd into the history feed at read time.
--
-- Idempotent: IF NOT EXISTS. Rollback: DROP TABLE agent_training_events CASCADE.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS agent_training_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL CHECK (event_type IN ('upload','remember','reflect')),
  walrus_blob_id  TEXT,
  sui_tx_digest   TEXT,
  namespace       TEXT,
  summary         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Hot path: list events by agent, newest first.
CREATE INDEX IF NOT EXISTS agent_training_events_agent_idx
  ON agent_training_events(agent_id, created_at DESC);
