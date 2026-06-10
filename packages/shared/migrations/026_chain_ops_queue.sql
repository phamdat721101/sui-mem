-- 026_chain_ops_queue.sql
-- PRD-19 — Gasless non-crypto seller onboarding (Arbitrum Sepolia).
--
-- One queue, one feature, one worker. Sellers never hold ETH; the platform
-- relayer (DEPLOYER_PRIVATE_KEY-aliased wallet) signs the on-chain
-- KnowledgeBaseRegistryV2.createBrain() call asynchronously after the
-- /v3/marketplace/seller/publish DB transaction commits.
--
-- SOLID:
--   - SRP: this table tracks pending on-chain ops, nothing else.
--   - OCP: extending to a new op_type (storeKey, addChunkHandle, …) is one
--     CHECK-constraint update + a new branch in chain-relayer.ts. The schema
--     and `payload` JSONB stay frozen.
--
-- Concurrency: workers claim rows via SELECT … FOR UPDATE SKIP LOCKED. The
-- (state, created_at) index keeps the claim O(log n) at any queue depth.
--
-- Rollback: FEATURE_GASLESS_ONBOARD=false → no rows ever inserted. The
-- table sits empty + harmless. Migration is additive only.
--
-- Idempotent: re-running this migration is safe.

-- §1 chain_ops_queue ----------------------------------------------------------

CREATE TABLE IF NOT EXISTS chain_ops_queue (
  id                 BIGSERIAL    PRIMARY KEY,
  op_type            TEXT         NOT NULL,
  agent_id           UUID         NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  seller_address     TEXT         NOT NULL,
  chain              TEXT         NOT NULL DEFAULT 'arbitrum-sepolia',
  state              TEXT         NOT NULL DEFAULT 'pending',
  payload            JSONB        NOT NULL DEFAULT '{}'::jsonb,
  tx_hash            TEXT,
  on_chain_brain_id  BIGINT,
  attempts           SMALLINT     NOT NULL DEFAULT 0,
  last_error         TEXT,
  claimed_at         TIMESTAMPTZ,
  confirmed_at       TIMESTAMPTZ,
  not_before         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now()
);

ALTER TABLE chain_ops_queue DROP CONSTRAINT IF EXISTS chain_ops_queue_op_type_check;
ALTER TABLE chain_ops_queue
  ADD CONSTRAINT chain_ops_queue_op_type_check
  CHECK (op_type IN ('create_brain'));

ALTER TABLE chain_ops_queue DROP CONSTRAINT IF EXISTS chain_ops_queue_state_check;
ALTER TABLE chain_ops_queue
  ADD CONSTRAINT chain_ops_queue_state_check
  CHECK (state IN ('pending', 'claimed', 'confirmed', 'failed'));

-- Worker claim path: pending rows whose backoff window has elapsed, oldest first.
CREATE INDEX IF NOT EXISTS chain_ops_queue_pending_idx
  ON chain_ops_queue (not_before, id)
  WHERE state = 'pending';

-- Status polling: latest op per agent. The DESC order matches the
-- `ORDER BY id DESC LIMIT 1` query in /seller/agent/:id/onchain-status.
CREATE INDEX IF NOT EXISTS chain_ops_queue_agent_idx
  ON chain_ops_queue (agent_id, id DESC);

-- Admin metrics: count by state in the last 24h.
CREATE INDEX IF NOT EXISTS chain_ops_queue_state_created_idx
  ON chain_ops_queue (state, created_at);

-- §2 agents on-chain mirror ---------------------------------------------------
-- The relayer writes these back after a successful tx so the listing card
-- and dashboard can render `✅ Live on-chain` without joining the queue.
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS on_chain_brain_id  BIGINT,
  ADD COLUMN IF NOT EXISTS on_chain_tx        TEXT,
  ADD COLUMN IF NOT EXISTS on_chain_chain     TEXT;
