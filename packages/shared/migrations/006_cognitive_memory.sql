-- 006_cognitive_memory.sql
-- OpenX Cognitive Memory v1 — L1/L2/L3 layers in Postgres.
-- Additive only. v2/v3/v4 schemas (brains, agents, agent_links, mpp_sessions,
-- bundles, agent_receipts, permits) are completely untouched.
--
-- Per-(user, layer) AES key is HKDF-derived from COGNITIVE_KEK env var; no
-- key table is needed. Phase 2 swaps the derivation for a Fhenix vault
-- lookup behind the same interface — no schema change required.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─── L1: episodic memory (every paid agent inference) ────────────────────────
CREATE TABLE IF NOT EXISTS cognitive_episodes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_addr    text NOT NULL,
  agent_id      text NOT NULL,                    -- the calling agent's address
  brain_id      bigint REFERENCES brains(id) ON DELETE SET NULL,
  topic         text NOT NULL,                    -- 16-hex topic key (matches Arkiv's format)
  session_id    text NOT NULL,
  -- payload_ct = AES-256-GCM(iv||tag||ciphertext) over the canonical episode JSON.
  payload_ct    bytea NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '7 days'
);
CREATE INDEX IF NOT EXISTS cognitive_episodes_owner_created_idx
  ON cognitive_episodes (owner_addr, created_at DESC);
CREATE INDEX IF NOT EXISTS cognitive_episodes_owner_topic_idx
  ON cognitive_episodes (owner_addr, topic);
CREATE INDEX IF NOT EXISTS cognitive_episodes_brain_idx
  ON cognitive_episodes (brain_id) WHERE brain_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cognitive_episodes_expires_idx
  ON cognitive_episodes (expires_at);

-- ─── L2: semantic facts (consolidator output) ────────────────────────────────
CREATE TABLE IF NOT EXISTS cognitive_facts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_addr    text NOT NULL,
  brain_id      bigint REFERENCES brains(id) ON DELETE SET NULL,
  topic         text NOT NULL,
  fact_type     text NOT NULL CHECK (fact_type IN ('fact','preference','relation','profile','event')),
  confidence    int  NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  -- derived_from is the array of L1 episode ids this fact was consolidated from.
  derived_from  jsonb NOT NULL DEFAULT '[]'::jsonb,
  payload_ct    bytea NOT NULL,
  -- procedure_key is set when the fact looks like a step in a recurring procedure;
  -- the L3 promoter groups facts by this key. Nullable.
  procedure_key text,
  -- topic_hash is a deterministic short hash used by the consolidator to
  -- dedup facts across runs (cosine ≥ 0.92 against existing facts, simplified
  -- for Phase 1 to a normalized substring match — see consolidator.ts).
  fact_hash     text NOT NULL,
  -- signer + signature: EIP-191 over canonical body (omitting signature). The
  -- signer is the brain owner; the consolidator (server-side) signs on their
  -- behalf with the same Memory-Agent-style trust we already use on /v4.
  signer        text NOT NULL,
  signature     text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '30 days'
);
CREATE INDEX IF NOT EXISTS cognitive_facts_owner_created_idx
  ON cognitive_facts (owner_addr, created_at DESC);
CREATE INDEX IF NOT EXISTS cognitive_facts_owner_topic_idx
  ON cognitive_facts (owner_addr, topic);
CREATE INDEX IF NOT EXISTS cognitive_facts_owner_proc_idx
  ON cognitive_facts (owner_addr, procedure_key) WHERE procedure_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS cognitive_facts_brain_idx
  ON cognitive_facts (brain_id) WHERE brain_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS cognitive_facts_owner_hash_uniq
  ON cognitive_facts (owner_addr, fact_hash);
CREATE INDEX IF NOT EXISTS cognitive_facts_expires_idx
  ON cognitive_facts (expires_at);

-- ─── L3: procedural skills (signed runnable bundles) ─────────────────────────
CREATE TABLE IF NOT EXISTS cognitive_skills (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_addr          text NOT NULL,
  brain_id            bigint REFERENCES brains(id) ON DELETE SET NULL,
  procedure_key       text NOT NULL,
  -- manifest_ct = AES-256-GCM(iv||tag||ciphertext) over the canonical bundle JSON.
  manifest_ct         bytea NOT NULL,
  -- input_schema / output_schema are kept plaintext: buyers must see them to
  -- decide whether to call. Steps are inside manifest_ct (encrypted).
  input_schema        jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_schema       jsonb NOT NULL DEFAULT '{}'::jsonb,
  signer              text NOT NULL,
  signature           text NOT NULL,
  -- Phase 2 hook: dormant in Phase 1; column exists so monetization can flip
  -- on with zero schema change.
  default_price_usdc  numeric(20,6) NOT NULL DEFAULT 0.05,
  derived_from        jsonb NOT NULL DEFAULT '[]'::jsonb,
  run_count           int NOT NULL DEFAULT 0,
  last_attestation    text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL DEFAULT now() + interval '90 days'
);
CREATE INDEX IF NOT EXISTS cognitive_skills_owner_created_idx
  ON cognitive_skills (owner_addr, created_at DESC);
CREATE INDEX IF NOT EXISTS cognitive_skills_brain_idx
  ON cognitive_skills (brain_id) WHERE brain_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS cognitive_skills_owner_proc_uniq
  ON cognitive_skills (owner_addr, procedure_key);
CREATE INDEX IF NOT EXISTS cognitive_skills_expires_idx
  ON cognitive_skills (expires_at);

-- ─── L3 run history (attestation feed on the brain detail page) ──────────────
CREATE TABLE IF NOT EXISTS cognitive_skill_runs (
  id            bigserial PRIMARY KEY,
  skill_id      uuid NOT NULL REFERENCES cognitive_skills(id) ON DELETE CASCADE,
  buyer         text NOT NULL,
  attestation   text NOT NULL,                    -- Phala attestation hash
  -- Hashes only — never the plaintext input/output. Preserves privacy in the
  -- public attestation feed while letting buyers verify provenance.
  input_hash    text NOT NULL,
  result_hash   text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cognitive_skill_runs_skill_idx
  ON cognitive_skill_runs (skill_id, created_at DESC);
