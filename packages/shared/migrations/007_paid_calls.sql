-- 007_paid_calls.sql — public x402 API endpoint support
--
-- Adds `slug` + `daily_request_cap` to `agents` for shareable URL routing,
-- and `paid_calls` ledger keyed by `(network, tx_hash)` for replay-safe
-- per-call settlement records (x402 + fherc20).

ALTER TABLE agents ADD COLUMN IF NOT EXISTS slug TEXT UNIQUE
  CHECK (slug ~ '^[a-z0-9-]{3,30}$');
ALTER TABLE agents ADD COLUMN IF NOT EXISTS daily_request_cap INTEGER
  DEFAULT 10000 CHECK (daily_request_cap > 0);

CREATE INDEX IF NOT EXISTS agents_slug_published_idx
  ON agents(slug) WHERE published = true;

CREATE TABLE IF NOT EXISTS paid_calls (
  id           BIGSERIAL PRIMARY KEY,
  agent_id     UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  slug         TEXT NOT NULL,
  buyer        TEXT NOT NULL,
  amount_usdc  NUMERIC(18,6) NOT NULL CHECK (amount_usdc > 0),
  tx_hash      TEXT NOT NULL,
  network      TEXT NOT NULL,
  method       TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (network, tx_hash)
);

CREATE INDEX IF NOT EXISTS paid_calls_slug_idx ON paid_calls(slug, created_at DESC);
CREATE INDEX IF NOT EXISTS paid_calls_buyer_idx ON paid_calls(buyer);
CREATE INDEX IF NOT EXISTS paid_calls_agent_idx ON paid_calls(agent_id, created_at DESC);
