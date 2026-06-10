-- 019_memwal_paid_queries.sql
-- Append-only ledger of every paid recall against a MemWalBrain.
-- Idempotent on (network, tx_hash) — protects against double-billing on retry.
-- Source of truth for /v3/memory/operator/stats and the on-chain settlement worker.

CREATE TABLE IF NOT EXISTS memwal_paid_queries (
  id                      BIGSERIAL PRIMARY KEY,
  brain_sui_object_id     VARCHAR(66) NOT NULL,
  buyer_wallet            VARCHAR(66) NOT NULL,
  payment_rail            VARCHAR(32) NOT NULL,         -- 'x402' | 'mpp' | 'sui_usdc' | 'memwal_per_call'
  amount_usdc             NUMERIC(18,6) NOT NULL,
  query_text_hash         VARCHAR(64) NOT NULL,         -- sha256 of plaintext (audit, no PII)
  recall_result_hash      VARCHAR(64),                  -- sha256 of joined result text
  ms_elapsed              INT,
  phala_attestation_hash  VARCHAR(66),                  -- nullable; Phala TEE
  payment_tx_hash         VARCHAR(66) NOT NULL,
  settlement_tx_hash      VARCHAR(66),                  -- nullable; set after batch settle
  refunded                BOOLEAN NOT NULL DEFAULT false,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memwal_paid_queries_tx
  ON memwal_paid_queries(payment_tx_hash);

CREATE INDEX IF NOT EXISTS idx_memwal_paid_queries_brain
  ON memwal_paid_queries(brain_sui_object_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memwal_paid_queries_buyer
  ON memwal_paid_queries(buyer_wallet, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memwal_paid_queries_pending_settle
  ON memwal_paid_queries(brain_sui_object_id)
  WHERE settlement_tx_hash IS NULL AND refunded = false;
