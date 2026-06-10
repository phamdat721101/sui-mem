-- 005_brain_access_requests.sql
-- Per-buyer access requests for non-owner inference calls.
-- Lifecycle: pending → paid (x402 settled) → granted (owner ran BrainKeyVault.grantBrainAccess)
--
-- Idempotency: (brain_id, buyer_address) is unique so repeated 402s coalesce.
-- The `granted_tx` is the on-chain proof; the FHE allow-list on the vault is
-- the cryptographic gate (this row is the human surface).

CREATE TABLE IF NOT EXISTS brain_access_requests (
  id            bigserial PRIMARY KEY,
  brain_id      bigint NOT NULL REFERENCES brains(id) ON DELETE CASCADE,
  buyer_address text   NOT NULL,
  paid_tx_hash  text,
  granted_tx    text,
  status        text   NOT NULL DEFAULT 'pending', -- pending | paid | granted | expired
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT brain_access_requests_buyer_lc CHECK (buyer_address = lower(buyer_address)),
  CONSTRAINT brain_access_requests_status_chk CHECK (status IN ('pending','paid','granted','expired'))
);

CREATE UNIQUE INDEX IF NOT EXISTS brain_access_requests_uniq
  ON brain_access_requests (brain_id, buyer_address);

CREATE INDEX IF NOT EXISTS brain_access_requests_status_idx
  ON brain_access_requests (status, created_at DESC);
