-- 023_marketplace_seller_fields.sql
-- Seller-first marketplace v1: extend `agents` with the public listing
-- surface (domain tag, short description, verification tier) + a stable
-- manifest snapshot (YAML + sha256 hash).
--
-- No new tables — the existing `agents JOIN brains` view IS the registry.
-- SOLID rule: extend, don't replicate. The research's separate
-- marketplace_listings/_manifests/_receipts tables (PRD-09 §4.1) would
-- duplicate ~90% of agents' columns; we keep one source of truth.
--
-- Idempotent: re-running is safe.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS domain text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS short_description text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS verification_tier text NOT NULL DEFAULT 'basic';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS manifest_yaml text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS manifest_hash bytea;

-- Closed enums via CHECK constraints. domain is nullable so existing rows
-- pass; new rows from /seller/publish enforce non-null at the API layer.
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_domain_check;
ALTER TABLE agents
  ADD CONSTRAINT agents_domain_check
  CHECK (domain IS NULL OR domain IN (
    'marketing',
    'finance',
    'research',
    'engineering',
    'generalist',
    'other'
  ));

ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_verification_tier_check;
ALTER TABLE agents
  ADD CONSTRAINT agents_verification_tier_check
  CHECK (verification_tier IN ('basic', 'verified', 'tee_attested'));

-- Catalog read path: domain filter on published rows.
CREATE INDEX IF NOT EXISTS agents_domain_published_idx
  ON agents (domain)
  WHERE published = true AND domain IS NOT NULL;
