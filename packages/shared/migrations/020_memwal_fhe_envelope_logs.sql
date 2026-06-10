-- 020_memwal_fhe_envelope_logs.sql
-- Audit log for the FHE × MemWal envelope (PRD-07).
-- NEVER stores plaintext, queries, or FHE keypair secrets — only object IDs
-- and content hashes for compliance + verification.

CREATE TABLE IF NOT EXISTS memwal_fhe_envelope_logs (
  id                    BIGSERIAL PRIMARY KEY,
  owner                 VARCHAR(66) NOT NULL,
  namespace             VARCHAR(128) NOT NULL,
  blob_id               VARCHAR(128),
  fhe_keypair_id        VARCHAR(128) NOT NULL,
  cofhe_tx_hash         VARCHAR(66),
  blinded_vector_hash   VARCHAR(64),
  op                    VARCHAR(16) NOT NULL,    -- 'wrap' | 'unwrap' | 'blindQuery' | 'permitIssue'
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memwal_fhe_logs_owner_ns
  ON memwal_fhe_envelope_logs(owner, namespace, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memwal_fhe_logs_op
  ON memwal_fhe_envelope_logs(op, created_at DESC);
