-- 011_trustless_tier.sql — Sui + Walrus + SEAL trustless-tier brain index.
--
-- Mirrors the existing `brains` (Standard tier) table but stores Sui object
-- IDs + Walrus blob refs instead of Postgres chunk pointers. Read-side
-- endpoints (`/v3/brains/:id/sovereignty-proof`, `/v3/brains/:id/cost`) hit
-- this table; the source-of-truth is Sui + Walrus, this is just a fast index.
--
-- The split table avoids polluting the Standard-tier `brains` schema with
-- nullable Sui fields. Migration to a unified table is a Phase 4 job.

CREATE TABLE IF NOT EXISTS brains_trustless (
  id              TEXT PRIMARY KEY,           -- Sui object id (0x…)
  owner_address   TEXT NOT NULL,
  sui_object_id   TEXT NOT NULL,
  seal_policy_id  TEXT NOT NULL,
  walrus_blob_ids TEXT[]  NOT NULL DEFAULT '{}',
  total_bytes     BIGINT  NOT NULL DEFAULT 0,
  content_metadata_hash TEXT NOT NULL DEFAULT '',
  kya_required    BOOLEAN NOT NULL DEFAULT false,
  min_reputation  INT     NOT NULL DEFAULT 0,
  published       BOOLEAN NOT NULL DEFAULT false,
  -- Optional seller webhook for Tatum-driven paid-query notifications.
  seller_webhook_url TEXT,
  -- Walrus blobs expire after ~5 epochs (~10 weeks). The renewal cron extends
  -- whenever (walrus_renewed_until - now) < 1 epoch (~14 days). Default value
  -- of "now" forces the first renewal pass to pick up newly-published brains.
  walrus_renewed_until TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS brains_trustless_owner_idx
  ON brains_trustless (LOWER(owner_address));

-- Index that backs the renewal cron's `WHERE walrus_renewed_until < ...` scan.
CREATE INDEX IF NOT EXISTS brains_trustless_renewal_idx
  ON brains_trustless (walrus_renewed_until) WHERE published = true;

-- Webhook DLQ (used by v3-tatum.ts forwarder when seller URL is down).
CREATE TABLE IF NOT EXISTS webhook_dlq (
  id          BIGSERIAL PRIMARY KEY,
  target_url  TEXT NOT NULL,
  payload     JSONB NOT NULL,
  last_error  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retried_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS webhook_dlq_unretried_idx
  ON webhook_dlq (created_at) WHERE retried_at IS NULL;
