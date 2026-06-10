-- 016_memwal_accounts.sql
-- One row per OpenX wallet that has provisioned a Sui MemWalAccount.
-- The Sui MemWalAccount object is the upstream `memwal::account.MemWalAccount`;
-- we cache its id + relayer URL here for fast adapter init without a Sui RPC roundtrip.

CREATE TABLE IF NOT EXISTS memwal_accounts (
  wallet_address     VARCHAR(66) PRIMARY KEY,
  sui_account_id     VARCHAR(66) NOT NULL,
  server_url         VARCHAR(256) NOT NULL,
  delegate_count     INT NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memwal_accounts_sui_id ON memwal_accounts(sui_account_id);
