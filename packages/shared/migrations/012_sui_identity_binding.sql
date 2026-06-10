-- 012_sui_identity_binding.sql — Bind a user's EVM address to their Sui
-- address so the Trustless tier can use the Sui address as the canonical
-- brain owner while EVM-side payments (x402 USDC on Base) still resolve to
-- the same human.
--
-- Replay protection: every link request carries a fresh `nonce` (UUID) and a
-- `linked_at` timestamp. The server enforces a 5-minute window in
-- routes/v3-identity.ts. Once stored, the (eth, sui) pair is a stable
-- identity edge — duplicate POSTs are idempotent.

CREATE TABLE IF NOT EXISTS sui_identity_bindings (
  evm_address  TEXT PRIMARY KEY,
  sui_address  TEXT NOT NULL UNIQUE,
  -- Hex-encoded ed25519 signature over the canonical message
  -- ("openx-link-sui:${evmAddress}:${suiAddress}:${nonce}:${ts}").
  signature    TEXT NOT NULL,
  nonce        TEXT NOT NULL,
  linked_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sui_bindings_sui_address
  ON sui_identity_bindings (sui_address);
