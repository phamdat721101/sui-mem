-- 024_seller_first_marketplace.sql
-- Seller-first marketplace v2: PRD-14 (seller↔agent split) +
-- PRD-15 (workflow/skill listing kinds) + PRD-16 (network-aware privacy)
-- consolidated into one migration per the locked plan.
--
-- SOLID rule: extend, don't replicate. Existing `agents` columns stay
-- untouched; new columns are nullable or DEFAULT-bearing for back-compat.
-- Idempotent: re-running is safe (IF NOT EXISTS + ON CONFLICT DO NOTHING).
--
-- Rollback: byte-identical to migration 023 when
-- FEATURE_MARKETPLACE_V1_SELLER_FIRST=false; the new columns sit unused.

-- §1 sellers table (PRD-14) -------------------------------------------------

CREATE TABLE IF NOT EXISTS sellers (
  id                 BIGSERIAL PRIMARY KEY,
  -- 128 chars accommodates EVM (0x + 40), Sui (0x + 64) and any future
  -- wider canonical address; the existing `agents.owner_address` is `text`.
  wallet_address     VARCHAR(128) NOT NULL UNIQUE,
  display_name       VARCHAR(120),
  bio                TEXT,
  identity_type      VARCHAR(20),
  identity_handle    VARCHAR(120),
  kya_proof_id       VARCHAR(120),
  kya_min_reputation INT NOT NULL DEFAULT 0,
  payout_method      VARCHAR(20) NOT NULL DEFAULT 'wallet',
  stripe_account_id  VARCHAR(64),
  contact_email      VARCHAR(180),
  support_url        VARCHAR(255),
  archived           BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sellers_kya_idx
  ON sellers (kya_proof_id) WHERE kya_proof_id IS NOT NULL;

-- Widen wallet_address for tables that were created with the old VARCHAR(64).
-- Idempotent: ALTER … TYPE is a no-op when the type already matches.
ALTER TABLE sellers ALTER COLUMN wallet_address TYPE VARCHAR(128);

-- §2 agents extensions (PRD-14 + PRD-15 + PRD-16) ---------------------------

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS seller_id          BIGINT REFERENCES sellers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS kind               VARCHAR(20) NOT NULL DEFAULT 'api',
  ADD COLUMN IF NOT EXISTS workflow_ref       VARCHAR(120),
  ADD COLUMN IF NOT EXISTS privacy_mode       VARCHAR(20) NOT NULL DEFAULT 'fhe',
  ADD COLUMN IF NOT EXISTS privacy_source     VARCHAR(10) NOT NULL DEFAULT 'auto',
  ADD COLUMN IF NOT EXISTS connected_chain_id BIGINT;

ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_kind_check;
ALTER TABLE agents
  ADD CONSTRAINT agents_kind_check
  CHECK (kind IN ('api', 'workflow', 'skill', 'brain'));

ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_privacy_mode_check;
ALTER TABLE agents
  ADD CONSTRAINT agents_privacy_mode_check
  CHECK (privacy_mode IN ('fhe', 'seal_walrus', 'metadata-only', 'off'));

ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_privacy_source_check;
ALTER TABLE agents
  ADD CONSTRAINT agents_privacy_source_check
  CHECK (privacy_source IN ('auto', 'manual'));

CREATE INDEX IF NOT EXISTS agents_seller_idx
  ON agents (seller_id) WHERE seller_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS agents_kind_published_idx
  ON agents (kind, published) WHERE published = true;

CREATE INDEX IF NOT EXISTS agents_privacy_mode_idx
  ON agents (privacy_mode);

-- §3 backfill (idempotent on UNIQUE(wallet_address)) ------------------------
-- NB: in the existing schema the agents wallet column is `owner_address`,
-- not `wallet_address`. Sellers' canonical column stays `wallet_address`
-- (that's the seller's wallet); we copy owner_address → wallet_address.

INSERT INTO sellers (wallet_address, display_name, payout_method, created_at)
SELECT DISTINCT lower(owner_address), lower(owner_address), 'wallet', now()
FROM agents WHERE owner_address IS NOT NULL
ON CONFLICT (wallet_address) DO NOTHING;

UPDATE agents
   SET seller_id = s.id
  FROM sellers s
 WHERE lower(agents.owner_address) = s.wallet_address
   AND agents.seller_id IS NULL;

-- Brain-backed agents become kind='brain'; pure HTTP/API listings stay 'api'.
-- Only touches default-state rows; never overwrites a deliberate kind.
UPDATE agents
   SET kind = 'brain'
 WHERE kind = 'api' AND brain_id IS NOT NULL;
