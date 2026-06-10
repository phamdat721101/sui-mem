-- 014_skills.sql
-- Standalone Skill product type (Sui marketplace).
--
-- Note: migration 006 already has `cognitive_skills` table for L3 procedural
-- bundles. The marketplace skill is a different concept (single-tool product
-- vs. compounded procedural), so this table is named distinctly.
--
-- Tier-isolation (G3): sui_object_id NOT NULL — only Sui-resident skills.

CREATE TABLE IF NOT EXISTS cognitive_skills_marketplace (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_key           text NOT NULL,
  author_addr         text NOT NULL,
  sui_object_id       text NOT NULL,
  manifest_blob_id    text NOT NULL,
  name                text NOT NULL,
  description         text NOT NULL DEFAULT '',
  -- Endpoint reference: { type: 'internal' | 'external', ref: <internal:name | https:url> }
  endpoint            jsonb NOT NULL,
  input_schema        jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_schema       jsonb NOT NULL DEFAULT '{}'::jsonb,
  default_price_usdc  numeric(20,6) NOT NULL,
  published           boolean NOT NULL DEFAULT false,
  kya_required        boolean NOT NULL DEFAULT false,
  min_reputation      int NOT NULL DEFAULT 0,
  signer              text NOT NULL,
  signature           text NOT NULL,
  invocations         int NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL DEFAULT now() + interval '180 days'
);

CREATE UNIQUE INDEX IF NOT EXISTS cognitive_skills_marketplace_author_key_uniq
  ON cognitive_skills_marketplace (author_addr, skill_key);
CREATE UNIQUE INDEX IF NOT EXISTS cognitive_skills_marketplace_sui_object_uniq
  ON cognitive_skills_marketplace (sui_object_id);
CREATE INDEX IF NOT EXISTS cognitive_skills_marketplace_published_idx
  ON cognitive_skills_marketplace (published, created_at DESC) WHERE published;
