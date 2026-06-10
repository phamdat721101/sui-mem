-- 015_reflective.sql
-- L5 ReflectiveTrace product type — additive only.
--
-- Reflective traces are sold as licenses (one-time purchase, multi-day
-- duration), not per-call. Tier-isolation (G3): sui_object_id NOT NULL.

CREATE TABLE IF NOT EXISTS cognitive_reflective (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_key           text NOT NULL,
  workflow_id         uuid NOT NULL REFERENCES cognitive_workflows(id) ON DELETE CASCADE,
  author_addr         text NOT NULL,
  sui_object_id       text NOT NULL,
  rules_blob_id       text NOT NULL,
  -- Observations + derived rules + derivedFrom — full canonical body.
  body                jsonb NOT NULL,
  default_license_price_usdc numeric(20,6) NOT NULL,
  published           boolean NOT NULL DEFAULT false,
  signer              text NOT NULL,
  signature           text NOT NULL,
  runs_observed       int NOT NULL DEFAULT 0,
  licenses_sold       int NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS cognitive_reflective_author_key_uniq
  ON cognitive_reflective (author_addr, trace_key);
CREATE UNIQUE INDEX IF NOT EXISTS cognitive_reflective_sui_object_uniq
  ON cognitive_reflective (sui_object_id);
CREATE INDEX IF NOT EXISTS cognitive_reflective_workflow_idx
  ON cognitive_reflective (workflow_id);
CREATE INDEX IF NOT EXISTS cognitive_reflective_published_idx
  ON cognitive_reflective (published, created_at DESC) WHERE published;

-- Per-licensee record for marketplace UI ("you own this license") + revenue.
CREATE TABLE IF NOT EXISTS cognitive_reflective_licenses (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id            uuid NOT NULL REFERENCES cognitive_reflective(id) ON DELETE CASCADE,
  licensee_addr       text NOT NULL,
  -- Sui License object id (from reflective::mint_license).
  sui_license_id      text NOT NULL,
  paid_usdc           numeric(20,6) NOT NULL,
  tx_hash             text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS cognitive_reflective_licenses_unique
  ON cognitive_reflective_licenses (trace_id, licensee_addr);
CREATE INDEX IF NOT EXISTS cognitive_reflective_licenses_licensee_idx
  ON cognitive_reflective_licenses (licensee_addr, created_at DESC);
