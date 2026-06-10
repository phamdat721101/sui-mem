-- 004_v3_agentic.sql
-- OpenX v3 — agentic marketplace tables. Additive only; v2 schemas untouched.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Agents = Brain + Persona (1:1 to brains, FK).
CREATE TABLE IF NOT EXISTS agents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brain_id        bigint NOT NULL REFERENCES brains(id) ON DELETE CASCADE,
  owner_address   text NOT NULL,
  chain           text NOT NULL CHECK (chain IN ('fhenix', 'sui')),
  -- persona: { system_prompt: string, tools: [], model: string }
  persona         jsonb NOT NULL,
  -- pricing: { x402: "0.01" | null, mpp: "0.01" | null, sui_usdc: "0.01" | null }
  pricing         jsonb NOT NULL,
  kya_required    boolean NOT NULL DEFAULT false,
  min_reputation  int NOT NULL DEFAULT 0,
  published       boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agents_owner_idx ON agents (owner_address);
CREATE INDEX IF NOT EXISTS agents_published_idx ON agents (published) WHERE published;
CREATE INDEX IF NOT EXISTS agents_brain_idx ON agents (brain_id);

-- AgentLinks: cross-chain identity binding (ERC-8004 ↔ KYAGate.move).
CREATE TABLE IF NOT EXISTS agent_links (
  canonical_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  eth_address     text,
  sui_address     text,
  eth_sig         text,
  sui_sig         text,
  reputation      int NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_links_at_least_one CHECK (eth_address IS NOT NULL OR sui_address IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_links_eth_idx ON agent_links (eth_address) WHERE eth_address IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS agent_links_sui_idx ON agent_links (sui_address) WHERE sui_address IS NOT NULL;

-- MPP Sessions (OAuth-for-money): one row per open session, voucher_log appended off-chain.
CREATE TABLE IF NOT EXISTS mpp_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  buyer           text NOT NULL,
  deposit_usdc    numeric(20,6) NOT NULL,
  consumed_usdc   numeric(20,6) NOT NULL DEFAULT 0,
  voucher_log     jsonb NOT NULL DEFAULT '[]'::jsonb,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','settling','closed')),
  opened_at       timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz
);
CREATE INDEX IF NOT EXISTS mpp_sessions_buyer_idx ON mpp_sessions (buyer);
CREATE INDEX IF NOT EXISTS mpp_sessions_agent_idx ON mpp_sessions (agent_id);

-- BundlePrompts: signed manifests issued by the discovery concierge.
CREATE TABLE IF NOT EXISTS bundles (
  id              text PRIMARY KEY,
  issuer          text NOT NULL,
  body            jsonb NOT NULL,
  signature       text NOT NULL,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bundles_expires_idx ON bundles (expires_at);

-- Per-rail receipts (provider earnings v3 reads from this).
CREATE TABLE IF NOT EXISTS agent_receipts (
  id              bigserial PRIMARY KEY,
  agent_id        uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  buyer           text NOT NULL,
  rail            text NOT NULL CHECK (rail IN ('x402','mpp','sui_usdc')),
  amount_usdc     numeric(20,6) NOT NULL,
  tx_or_receipt   text NOT NULL,
  bundle_id       text REFERENCES bundles(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_receipts_agent_idx ON agent_receipts (agent_id);
CREATE INDEX IF NOT EXISTS agent_receipts_buyer_idx ON agent_receipts (buyer);
CREATE INDEX IF NOT EXISTS agent_receipts_rail_idx ON agent_receipts (rail);
