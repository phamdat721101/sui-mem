-- 025_onboard_permits_spent.sql
-- PRD-18 — Permit-authenticated one-prompt onboarding.
--
-- Single-use ledger for scoped Fhenix onboard permits issued from /docs.
-- Each permit carries a unique `jti` encoded inside its `name` field
-- (`openx-onboard:<jti>`). This table records consumption: one INSERT per
-- successful publish, atomically inside sellerPublishService.publish().
--
-- The PRIMARY KEY on `jti` is the single-use enforcement: a replay attempt
-- reuses the same jti and the INSERT … ON CONFLICT DO NOTHING returns 0 rows,
-- which the service translates into HTTP 409.
--
-- `expires_at` lets a separate cleanup cron prune old rows; until then they
-- remain harmlessly idempotent. Default TTL is 15 min (set by the SDK), so
-- the table stays tiny even at high publish throughput.
--
-- Idempotent: re-running this migration is safe.

CREATE TABLE IF NOT EXISTS onboard_permits_spent (
  jti             TEXT        PRIMARY KEY,
  wallet_address  TEXT        NOT NULL,
  used_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL
);

-- Cleanup cron uses this index. Single small B-tree; no other read paths
-- need to query the table (single-use lookup is by PK).
CREATE INDEX IF NOT EXISTS onboard_permits_spent_expires_idx
  ON onboard_permits_spent (expires_at);
