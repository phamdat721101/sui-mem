/**
 * Brain shape — Sui-native after the EVM/Fhenix pivot.
 *
 * SOLID:
 * - SRP: type definitions only; no runtime logic.
 * - OCP: adding a new Sui chain (e.g. devnet) = one literal entry.
 */

export type ChainKey = 'sui-testnet' | 'sui-mainnet' | 'sui-devnet';

export interface AttestationReceipt {
  /** e.g. 'phala-tee', 'seal-threshold', 'walrus-quilt'. */
  provider: string;
  /** Opaque cryptographic quote for client-side verification. */
  quote: string;
  /** Whether the SDK verified the quote locally. */
  verified: boolean;
  /** ISO timestamp when the receipt was issued. */
  issuedAt: string;
}

export interface Brain {
  id: string;
  owner_address: string;
  title: string;
  description: string;
  tags: string[];
  published: boolean;
  created_at: string;
  /** Sui MemWal namespace (cog-l{N}-{brainId}). */
  namespace?: string;
  /** Walrus blob ids backing the brain content. */
  walrusBlobIds?: string[];
}
