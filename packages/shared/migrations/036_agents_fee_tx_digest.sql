-- Migration 036 — track on-chain $1 USDC publish fee tx digest per agent.
-- Additive ALTER; legacy publishes have NULL (backward compatible). The
-- index supports the seller dashboard's "publish fees paid" aggregate.

BEGIN;

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS fee_tx_digest TEXT;

CREATE INDEX IF NOT EXISTS idx_agents_fee_tx_digest
  ON agents (fee_tx_digest)
  WHERE fee_tx_digest IS NOT NULL;

COMMIT;
