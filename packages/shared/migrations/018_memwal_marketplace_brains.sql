-- 018_memwal_marketplace_brains.sql
-- One row per published MemWalBrain (mirrors the Sui Move object).
-- The Move object is the source of truth; this table is a fast read cache
-- for marketplace listings and the sovereignty-proof endpoint.

CREATE TABLE IF NOT EXISTS memwal_marketplace_brains (
  id                       BIGSERIAL PRIMARY KEY,
  sui_object_id            VARCHAR(66) UNIQUE NOT NULL,
  seller_wallet            VARCHAR(66) NOT NULL,
  memwal_account_id        VARCHAR(66) NOT NULL,
  namespace                VARCHAR(128) NOT NULL,
  title                    VARCHAR(256) NOT NULL,
  description              TEXT,
  price_per_query_usdc     NUMERIC(18,6) NOT NULL,
  kya_required             BOOLEAN NOT NULL DEFAULT false,
  attestation_required     SMALLINT NOT NULL DEFAULT 0,   -- 0=none, 1=phala-tee, 2=fhe-envelope
  cognitive_level          SMALLINT NOT NULL DEFAULT 3,   -- 1..5 (L1 episodic .. L5 reflective)
  sovereignty_proof_url    VARCHAR(512),
  active                   BOOLEAN NOT NULL DEFAULT true,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memwal_marketplace_seller ON memwal_marketplace_brains(seller_wallet);
CREATE INDEX IF NOT EXISTS idx_memwal_marketplace_active ON memwal_marketplace_brains(active, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memwal_marketplace_level ON memwal_marketplace_brains(cognitive_level, active);
