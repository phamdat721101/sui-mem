-- 021_memwal_revenue_settlements.sql
-- Records each on-chain settlement batch produced by the operator service.
-- One row = one `settle_batch` Sui tx that fanned out USDC to seller(s) + operator.
-- Multi-author composition policy is captured in `composition_authors` JSONB
-- (array of {wallet, bps, amount_usdc}) for full audit reconstruction.

CREATE TABLE IF NOT EXISTS memwal_revenue_settlements (
  id                       BIGSERIAL PRIMARY KEY,
  brain_sui_object_id      VARCHAR(66) NOT NULL,
  settlement_tx_hash       VARCHAR(66) UNIQUE NOT NULL,
  total_usdc               NUMERIC(18,6) NOT NULL,
  query_count              INT NOT NULL,
  seller_wallet            VARCHAR(66) NOT NULL,
  seller_amount_usdc       NUMERIC(18,6) NOT NULL,
  operator_amount_usdc     NUMERIC(18,6) NOT NULL,
  operator_bps             INT NOT NULL DEFAULT 500,        -- 5% default; volume dial may override
  composition_authors      JSONB,                            -- [{wallet, bps, amount_usdc}, ...]
  settled_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memwal_settlements_brain
  ON memwal_revenue_settlements(brain_sui_object_id, settled_at DESC);

CREATE INDEX IF NOT EXISTS idx_memwal_settlements_seller
  ON memwal_revenue_settlements(seller_wallet, settled_at DESC);
