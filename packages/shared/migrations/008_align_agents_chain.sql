-- 008_align_agents_chain.sql — widen agents.chain enum to accept the canonical
-- chain identifiers used by the rest of the system. Brains, paid_calls, v2
-- chat headers, and the public OpenAPI advert all use 'arbitrum-sepolia';
-- the agents table was the only place still on the legacy 'fhenix'-only enum,
-- which broke POST /v3/agents from the publish wizard. Backwards-compatible:
-- existing rows with chain='fhenix' remain valid; 'sui' kept for the parked
-- dual-chain rail.

ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_chain_check;
ALTER TABLE agents
  ADD CONSTRAINT agents_chain_check
  CHECK (chain IN ('arbitrum-sepolia', 'fhenix', 'sui'));
