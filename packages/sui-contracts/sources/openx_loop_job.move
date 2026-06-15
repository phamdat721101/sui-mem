/// openx_loop_job — Mode B escrow + iter timeline.
///
/// `LoopJob` is a buyer-owned (logically) shared object that:
///   - holds `Balance<T>` (canonical T = USDC) escrow funded at hire time,
///   - tracks the iter state machine (RUNNING / PAUSED_* / DONE / CANCELLED),
///   - records per-iter encrypted result handles as a vector — folding what
///     arb-mem split into `LoopJob` + `FheLoopMemory`. Walrus blob IDs are
///     public anyway; per-policy decryption is gated by Seal threshold servers
///     via `seal_approve_*` Move guards, so we don't need a separate access-
///     list contract.
///
/// SOLID:
///   - SRP: this module owns escrow + iter state + Seal approvers. Spawning
///     lives in `openx_loop_job_factory`. Iter receipts (events) live in
///     `openx_loop_iter_receipt`. Checkpoint approval lives in
///     `openx_loop_checkpoint`.
///   - DIP: `RUNNER_CAP` from `openx_loop_agent_registry` gates iter advance.
///   - LSP: generic `<T>` for the coin type — tests use SUI, prod uses USDC.
module fhe_brain::openx_loop_job {
    use sui::event;
    use sui::balance::{Self, Balance};
    use sui::coin::{Self, Coin};
    use sui::clock::{Self, Clock};
    use std::string::{Self, String};
    use fhe_brain::openx_loop_agent_registry::{Agent, RunnerCap};

    // ─── Errors ──────────────────────────────────────────────────────────

    const EInvalidStatus: u64 = 0;
    const ENotBuyer: u64 = 1;
    const EBudgetExceeded: u64 = 2;
    const EMaxIterReached: u64 = 3;
    const EWrongIterN: u64 = 4;
    const EBadSplits: u64 = 5;
    const EIterOutOfRange: u64 = 6;

    // Status enum — kept as u8 for cheap comparisons in events + reads.
    const STATUS_RUNNING: u8 = 0;
    const STATUS_PAUSED_BUDGET: u8 = 1;
    const STATUS_PAUSED_CHECKPOINT: u8 = 2;
    const STATUS_DONE: u8 = 3;
    const STATUS_CANCELLED: u8 = 4;

    // ─── Object ──────────────────────────────────────────────────────────

    /// One encrypted iter result. `walrus_blob_id` references the AES-GCM
    /// ciphertext; `attestation_hash` is the Phala TEE quote digest.
    public struct IterResult has store, copy, drop {
        iter_n: u64,
        walrus_blob_id: String,
        attestation_hash: vector<u8>,
        ts_ms: u64,
    }

    public struct LoopJob<phantom T> has key {
        id: UID,
        buyer: address,
        agent_id: ID,
        manifest_walrus_blob_id: String,
        max_iterations: u64,
        budget_micro: u64,
        escrow: Balance<T>,
        status: u8,
        iterations_done: u64,
        spent_micro: u64,
        iter_results: vector<IterResult>,
        created_at_ms: u64,
        last_iter_at_ms: u64,
        completed_at_ms: u64,
    }

    // ─── Events ──────────────────────────────────────────────────────────

    public struct LoopJobCreated has copy, drop {
        job_id: ID,
        buyer: address,
        agent_id: ID,
        budget_micro: u64,
        max_iterations: u64,
    }

    public struct LoopJobStatusChanged has copy, drop {
        job_id: ID,
        old_status: u8,
        new_status: u8,
    }

    public struct LoopIterAdvanced has copy, drop {
        job_id: ID,
        iter_n: u64,
        walrus_blob_id: String,
        attestation_hash: vector<u8>,
        amount_paid_micro: u64,
        seller_cut_micro: u64,
        compute_cut_micro: u64,
        platform_cut_micro: u64,
    }

    public struct LoopJobRefunded has copy, drop {
        job_id: ID,
        buyer: address,
        amount_micro: u64,
    }

    public struct LoopJobCompleted has copy, drop {
        job_id: ID,
        buyer: address,
        iterations_done: u64,
        spent_micro: u64,
    }

    // ─── Construction (called by factory) ────────────────────────────────

    /// Public constructor — exposed so `openx_loop_job_factory` can spawn
    /// inside one tx. Not `entry` — buyers go through the factory.
    public fun new_job<T>(
        buyer: address,
        agent: &Agent,
        max_iterations: u64,
        budget_coin: Coin<T>,
        clock: &Clock,
        ctx: &mut TxContext,
    ): LoopJob<T> {
        let now = clock::timestamp_ms(clock);
        let agent_id = object::id(agent);
        let budget_micro = coin::value(&budget_coin);
        // `manifest()` returns `&String`; deref-copy is safe because String has `copy`.
        let manifest = *fhe_brain::openx_loop_agent_registry::manifest(agent);
        let job = LoopJob<T> {
            id: object::new(ctx),
            buyer,
            agent_id,
            manifest_walrus_blob_id: manifest,
            max_iterations,
            budget_micro,
            escrow: coin::into_balance(budget_coin),
            status: STATUS_RUNNING,
            iterations_done: 0,
            spent_micro: 0,
            iter_results: vector<IterResult>[],
            created_at_ms: now,
            last_iter_at_ms: 0,
            completed_at_ms: 0,
        };
        event::emit(LoopJobCreated {
            job_id: object::id(&job),
            buyer,
            agent_id,
            budget_micro,
            max_iterations,
        });
        job
    }

    /// Share the job — called by the factory after `new_job`.
    public fun share<T>(job: LoopJob<T>) {
        transfer::share_object(job);
    }

    // ─── Iter advance (RUNNER_CAP only) ──────────────────────────────────

    /// Advance one iter and atomically split `amount_paid_micro` 70/25/5
    /// (or whatever the agent's manifest says) — 3 inline transfers from
    /// escrow. Records the encrypted result handle.
    public entry fun advance_iter_with_split<T>(
        _runner: &RunnerCap,
        job: &mut LoopJob<T>,
        agent: &Agent,
        iter_n: u64,
        walrus_blob_id: vector<u8>,
        attestation_hash: vector<u8>,
        amount_paid_micro: u64,
        compute_treasury: address,
        platform_treasury: address,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(job.status == STATUS_RUNNING, EInvalidStatus);
        assert!(job.iterations_done + 1 == iter_n, EWrongIterN);
        assert!(iter_n <= job.max_iterations, EMaxIterReached);
        assert!(job.spent_micro + amount_paid_micro <= job.budget_micro, EBudgetExceeded);

        let (seller_bps, compute_bps, _platform_bps) = fhe_brain::openx_loop_agent_registry::splits(agent);
        let seller_cut = amount_paid_micro * (seller_bps as u64) / 10_000;
        let compute_cut = amount_paid_micro * (compute_bps as u64) / 10_000;
        let platform_cut = amount_paid_micro - seller_cut - compute_cut;

        let seller_coin = coin::from_balance(balance::split(&mut job.escrow, seller_cut), ctx);
        let compute_coin = coin::from_balance(balance::split(&mut job.escrow, compute_cut), ctx);
        let platform_coin = coin::from_balance(balance::split(&mut job.escrow, platform_cut), ctx);
        transfer::public_transfer(seller_coin, fhe_brain::openx_loop_agent_registry::seller(agent));
        transfer::public_transfer(compute_coin, compute_treasury);
        transfer::public_transfer(platform_coin, platform_treasury);

        let blob_str = string::utf8(walrus_blob_id);
        job.iterations_done = iter_n;
        job.spent_micro = job.spent_micro + amount_paid_micro;
        job.last_iter_at_ms = clock::timestamp_ms(clock);
        job.iter_results.push_back(IterResult {
            iter_n,
            walrus_blob_id: blob_str,
            attestation_hash,
            ts_ms: job.last_iter_at_ms,
        });

        event::emit(LoopIterAdvanced {
            job_id: object::id(job),
            iter_n,
            walrus_blob_id: blob_str,
            attestation_hash,
            amount_paid_micro,
            seller_cut_micro: seller_cut,
            compute_cut_micro: compute_cut,
            platform_cut_micro: platform_cut,
        });
    }

    // ─── Buyer-controlled lifecycle ──────────────────────────────────────

    public entry fun pause<T>(job: &mut LoopJob<T>, ctx: &TxContext) {
        assert!(job.buyer == ctx.sender(), ENotBuyer);
        assert!(job.status == STATUS_RUNNING, EInvalidStatus);
        let old = job.status;
        job.status = STATUS_PAUSED_BUDGET;
        event::emit(LoopJobStatusChanged { job_id: object::id(job), old_status: old, new_status: job.status });
    }

    public entry fun resume<T>(job: &mut LoopJob<T>, ctx: &TxContext) {
        assert!(job.buyer == ctx.sender(), ENotBuyer);
        assert!(
            job.status == STATUS_PAUSED_BUDGET || job.status == STATUS_PAUSED_CHECKPOINT,
            EInvalidStatus,
        );
        let old = job.status;
        job.status = STATUS_RUNNING;
        event::emit(LoopJobStatusChanged { job_id: object::id(job), old_status: old, new_status: job.status });
    }

    public entry fun cancel<T>(job: &mut LoopJob<T>, clock: &Clock, ctx: &mut TxContext) {
        assert!(job.buyer == ctx.sender(), ENotBuyer);
        assert!(job.status != STATUS_DONE && job.status != STATUS_CANCELLED, EInvalidStatus);
        let old = job.status;
        job.status = STATUS_CANCELLED;
        job.completed_at_ms = clock::timestamp_ms(clock);
        event::emit(LoopJobStatusChanged { job_id: object::id(job), old_status: old, new_status: job.status });
        refund_residual(job, ctx);
    }

    /// Runner-completes when work is done early (budget remains).
    public entry fun complete<T>(
        _runner: &RunnerCap,
        job: &mut LoopJob<T>,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(job.status == STATUS_RUNNING, EInvalidStatus);
        let old = job.status;
        job.status = STATUS_DONE;
        job.completed_at_ms = clock::timestamp_ms(clock);
        event::emit(LoopJobStatusChanged { job_id: object::id(job), old_status: old, new_status: job.status });
        event::emit(LoopJobCompleted {
            job_id: object::id(job),
            buyer: job.buyer,
            iterations_done: job.iterations_done,
            spent_micro: job.spent_micro,
        });
        refund_residual(job, ctx);
    }

    fun refund_residual<T>(job: &mut LoopJob<T>, ctx: &mut TxContext) {
        let remaining = balance::value(&job.escrow);
        if (remaining > 0) {
            let coin = coin::from_balance(balance::split(&mut job.escrow, remaining), ctx);
            transfer::public_transfer(coin, job.buyer);
            event::emit(LoopJobRefunded { job_id: object::id(job), buyer: job.buyer, amount_micro: remaining });
        };
    }

    // ─── Seal approvers (per-iter access gate) ───────────────────────────

    /// Runner derives decryption capability for iter N's encrypted input.
    public fun seal_approve_runner_iter_decrypt<T>(
        job: &LoopJob<T>,
        iter_n: u64,
        _clock: &Clock,
    ) {
        // iter_n must be in [1, iterations_done + 1] — runner can decrypt
        // already-advanced iters (audit) or the next pending iter (execution).
        assert!(iter_n >= 1 && iter_n <= job.iterations_done + 1, EIterOutOfRange);
    }

    /// Buyer derives decryption capability for any completed iter.
    public fun seal_approve_buyer_iter_decrypt<T>(
        job: &LoopJob<T>,
        iter_n: u64,
        ctx: &TxContext,
    ) {
        assert!(job.buyer == ctx.sender(), ENotBuyer);
        assert!(iter_n >= 1 && iter_n <= job.iterations_done, EIterOutOfRange);
    }

    // ─── Read accessors ─────────────────────────────────────────────────

    public fun buyer<T>(j: &LoopJob<T>): address { j.buyer }
    public fun agent_id<T>(j: &LoopJob<T>): ID { j.agent_id }
    public fun status<T>(j: &LoopJob<T>): u8 { j.status }
    public fun iterations_done<T>(j: &LoopJob<T>): u64 { j.iterations_done }
    public fun max_iterations<T>(j: &LoopJob<T>): u64 { j.max_iterations }
    public fun spent_micro<T>(j: &LoopJob<T>): u64 { j.spent_micro }
    public fun budget_micro<T>(j: &LoopJob<T>): u64 { j.budget_micro }
    public fun escrow_remaining<T>(j: &LoopJob<T>): u64 { balance::value(&j.escrow) }
    public fun iter_results<T>(j: &LoopJob<T>): &vector<IterResult> { &j.iter_results }

    public fun status_running(): u8 { STATUS_RUNNING }
    public fun status_done(): u8 { STATUS_DONE }
    public fun status_cancelled(): u8 { STATUS_CANCELLED }
    public fun status_paused_budget(): u8 { STATUS_PAUSED_BUDGET }
    public fun status_paused_checkpoint(): u8 { STATUS_PAUSED_CHECKPOINT }
}
