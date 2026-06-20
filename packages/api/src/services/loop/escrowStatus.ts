/**
 * services/loop/escrowStatus.ts — derive the four UX states of a workflow
 * escrow / legacy subscription from a single Postgres row.
 *
 * SOLID: SRP — one pure function, one source of truth. Every consumer (the
 * cron skip-list, the buyer's /activity rows, the seller's ACTIVE_HIRES
 * panel) reads through here so we never end up with three subtly different
 * "stopped vs cancelled vs exhausted" rules across modules.
 *
 * PRD decision 2=a: status is *derived*, not stored. Only the on-chain
 * truth (escrow_remaining_micro, runs_remaining, cancelled_at) is canonical.
 */

export type EscrowStatus = 'active' | 'stopped' | 'cancelled' | 'exhausted';

/**
 * Subset of `loop_subscriptions` columns required to compute status.
 * Intentionally narrow — keeps callers from passing kitchen-sink rows.
 */
export interface EscrowStatusInput {
  cancelled_at: Date | string | null;
  runs_remaining: number;
  /** Stored as BIGINT in Postgres; comes back as a string from `pg`. */
  escrow_remaining_micro: string | number | bigint;
  max_per_run_micro: string | number | bigint;
}

/**
 * Decision tree (top → bottom):
 *   1. cancelled_at → 'cancelled'   (terminal — buyer refunded)
 *   2. runs_remaining === 0 → 'exhausted'   (escrow drained naturally)
 *   3. escrow_remaining < max_per_run → 'stopped'   (top-up needed)
 *   4. otherwise → 'active'
 *
 * BigInt-safe: pg returns BIGINTs as strings to avoid JS-Number precision
 * loss. We coerce both sides via BigInt() so 9_007_199_254_740_993 µUSDC
 * still compares correctly.
 */
export function deriveStatus(row: EscrowStatusInput): EscrowStatus {
  if (row.cancelled_at) return 'cancelled';
  if (row.runs_remaining <= 0) return 'exhausted';
  const escrow = BigInt(row.escrow_remaining_micro);
  const cap = BigInt(row.max_per_run_micro);
  if (escrow < cap) return 'stopped';
  return 'active';
}
