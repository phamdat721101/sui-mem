/// openx_memwal_billing — append-only ledger of paid MemWal queries.
///
/// One Move object per paid query. The off-chain API gateway emits a
/// `record_paid_query` tx after the buyer's x402 voucher clears + the
/// adapter returns recall results. The settlement worker then batches N
/// `PaidQuery` objects into one `revenue_split.distribute()` call.
///
/// Why on-chain ledger:
///   - Sovereignty proof — buyer earnings are reconstructable from chain
///     alone, even with OpenX Postgres down.
///   - Idempotency — duplicate `payment_tx_hash` is rejected by the
///     off-chain `paidCallLedger` (Postgres unique index 019), so we
///     never re-emit the same `PaidQueryRecorded` event.
///
/// SOLID:
///   - SRP: ledger only. Splits + transfers live in `revenue_split.move`.
///   - LSP: every paid query has the same struct shape regardless of tier
///     (phala-tee / fhe-envelope) so settlement code is uniform.
module fhe_brain::openx_memwal_billing {
    use sui::event;
    use sui::clock::{Self, Clock};
    use std::string::{Self, String};
    use fhe_brain::openx_memwal_marketplace::{Self as mp, MemWalBrain};

    // ─── Events ──────────────────────────────────────────────────────────

    public struct PaidQueryRecorded has copy, drop {
        brain_id: ID,
        buyer: address,
        seller: address,
        operator: address,
        amount_usdc_micro: u64,
        attestation_hash: vector<u8>,
        x402_tx_hash: vector<u8>,
        rail: String,
        ts_ms: u64,
    }

    public struct SettlementBatchEmitted has copy, drop {
        brain_id: ID,
        batch_size: u64,
        total_usdc_micro: u64,
        operator: address,
        ts_ms: u64,
    }

    // ─── Entry functions ─────────────────────────────────────────────────

    /// Record a single paid query. The off-chain operator pays gas; this
    /// emits an event the settlement worker watches. We pass `&MemWalBrain`
    /// (not `ID`) so the buyer's wallet sees the brain's seller in their tx
    /// preview — full transparency, no opaque ids.
    public entry fun record_paid_query(
        brain: &MemWalBrain,
        buyer: address,
        amount_usdc_micro: u64,
        attestation_hash: vector<u8>,
        x402_tx_hash: vector<u8>,
        rail: vector<u8>,
        clock: &Clock,
        ctx: &TxContext,
    ) {
        event::emit(PaidQueryRecorded {
            brain_id: object::id(brain),
            buyer,
            seller: mp::seller(brain),
            operator: ctx.sender(),
            amount_usdc_micro,
            attestation_hash,
            x402_tx_hash,
            rail: string::utf8(rail),
            ts_ms: clock::timestamp_ms(clock),
        });
    }

    /// Emit a settlement-batch event after `revenue_split.distribute` runs.
    /// Pure marker — used by indexers + dashboard /v3/dashboard/stats.
    public entry fun settle_batch(
        brain: &MemWalBrain,
        batch_size: u64,
        total_usdc_micro: u64,
        clock: &Clock,
        ctx: &TxContext,
    ) {
        event::emit(SettlementBatchEmitted {
            brain_id: object::id(brain),
            batch_size,
            total_usdc_micro,
            operator: ctx.sender(),
            ts_ms: clock::timestamp_ms(clock),
        });
    }
}
