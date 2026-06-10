-- 022_widen_agents_chain.sql
-- Widen the `agents.chain` CHECK constraint so the publish wizard can
-- store rows for the Sui tier on either testnet or mainnet. Earlier
-- migrations (004 + 008) only allowed { 'arbitrum-sepolia', 'fhenix',
-- 'sui' }; the wizard now passes 'sui-testnet' / 'sui-mainnet' which
-- carry network identity through to UI labels (chainLabel + the buyer's
-- "Pay with" selector).
--
-- Idempotent: re-running drops + recreates with the same final list.
-- Forward-compat: includes 'base-sepolia' so the next rail rollout
-- (Base USDC vouchers via x402) doesn't need another migration.

ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_chain_check;
ALTER TABLE agents
  ADD CONSTRAINT agents_chain_check
  CHECK (chain IN (
    'arbitrum-sepolia',
    'fhenix',
    'sui',
    'sui-testnet',
    'sui-mainnet',
    'base-sepolia'
  ));
