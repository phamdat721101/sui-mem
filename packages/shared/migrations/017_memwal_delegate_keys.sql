-- 017_memwal_delegate_keys.sql
-- Tracks every Ed25519 delegate key the OpenX operator has registered onchain
-- under a seller's MemWalAccount. Supports BOTH operator pattern (role='openx-operator')
-- and delegate-add pattern (role='buyer', expires_at set, budget_usdc optional).
-- Cron worker scans expires_at < now() to auto-revoke.

CREATE TABLE IF NOT EXISTS memwal_delegate_keys (
  id                     BIGSERIAL PRIMARY KEY,
  owner_wallet           VARCHAR(66) NOT NULL,
  memwal_account_id      VARCHAR(66) NOT NULL,
  delegate_pubkey_hex    VARCHAR(66) NOT NULL,
  delegate_sui_address   VARCHAR(66) NOT NULL,
  role                   VARCHAR(16) NOT NULL,    -- 'openx-operator' | 'buyer' | 'team-member'
  buyer_wallet           VARCHAR(66),             -- nullable; set for delegate-add pattern
  label                  VARCHAR(64),
  expires_at             TIMESTAMPTZ,             -- nullable; set for time-bound delegates
  budget_usdc            NUMERIC(18,6),           -- nullable; team-budget mode
  spent_usdc             NUMERIC(18,6) DEFAULT 0,
  revoked_at             TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memwal_delegate_active
  ON memwal_delegate_keys(memwal_account_id, delegate_pubkey_hex)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_memwal_delegate_expiry
  ON memwal_delegate_keys(expires_at)
  WHERE expires_at IS NOT NULL AND revoked_at IS NULL;
