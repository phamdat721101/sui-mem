/// openx_loop_iter_receipt — per-iter receipt event (replaces EAS attestations).
///
/// Sui events are the canonical sovereignty record. This module exists as a
/// distinct surface so off-chain indexers can subscribe to one event stream
/// without filtering on `LoopIterAdvanced` (which is the *settlement* event).
/// `LoopIterReceipt` carries the response digest + signing addr — useful for
/// downstream attestation verification flows.
///
/// SOLID:
///   - SRP: emit one event. No state, no transfers.
module fhe_brain::openx_loop_iter_receipt {
    use sui::event;
    use std::string::{Self, String};
    use fhe_brain::openx_loop_agent_registry::RunnerCap;

    public struct LoopIterReceipt has copy, drop {
        job_id: ID,
        iter_n: u64,
        response_walrus_blob_id: String,
        attestation_hash: vector<u8>,
        response_digest_sha256: vector<u8>,
        amount_paid_micro: u64,
        runner_signing_address: address,
        ts_ms: u64,
    }

    public entry fun emit_receipt(
        _runner: &RunnerCap,
        job_id: ID,
        iter_n: u64,
        response_walrus_blob_id: vector<u8>,
        attestation_hash: vector<u8>,
        response_digest_sha256: vector<u8>,
        amount_paid_micro: u64,
        ts_ms: u64,
        ctx: &TxContext,
    ) {
        event::emit(LoopIterReceipt {
            job_id,
            iter_n,
            response_walrus_blob_id: string::utf8(response_walrus_blob_id),
            attestation_hash,
            response_digest_sha256,
            amount_paid_micro,
            runner_signing_address: ctx.sender(),
            ts_ms,
        });
    }
}
