/// openx_loop_checkpoint — human-in-loop gate for Mode B.
///
/// Runner pauses iter execution, calls `request`; buyer approves; on timeout
/// anyone can mark the checkpoint timed-out (LoopJob then resumes via the
/// usual buyer `resume()` or runner `complete()`).
///
/// SOLID:
///   - SRP: only owns the checkpoint state machine. No reach into LoopJob.
///   - DIP: keyed by `(job_id, iter_n)` — checkpoints are LoopJob-agnostic.
///     The runner verifies buyer identity off-chain before resuming the job.
module fhe_brain::openx_loop_checkpoint {
    use sui::event;
    use sui::clock::{Self, Clock};
    use sui::table::{Self, Table};
    use fhe_brain::openx_loop_agent_registry::RunnerCap;

    const EAlreadyExists: u64 = 0;
    const ENotFound: u64 = 1;
    const EAlreadyDecided: u64 = 2;
    const ENotYetTimedOut: u64 = 3;

    public struct CheckpointRegistry has key {
        id: UID,
        // Key = bcs::to_bytes((job_id, iter_n)). Hash collision-free for our use.
        items: Table<vector<u8>, Checkpoint>,
    }

    public struct Checkpoint has store, drop, copy {
        job_id: ID,
        iter_n: u64,
        requested_at_ms: u64,
        timeout_ms: u64,
        approved_by: address,
        approved_at_ms: u64,
        approved: bool,
        timed_out: bool,
    }

    public struct CheckpointRequested has copy, drop { job_id: ID, iter_n: u64, timeout_ms: u64 }
    public struct CheckpointApproved has copy, drop { job_id: ID, iter_n: u64, approved_by: address }
    public struct CheckpointTimedOut has copy, drop { job_id: ID, iter_n: u64 }

    fun init(ctx: &mut TxContext) {
        let reg = CheckpointRegistry {
            id: object::new(ctx),
            items: table::new<vector<u8>, Checkpoint>(ctx),
        };
        transfer::share_object(reg);
    }

    /// Test-only — share a registry from inside `test_scenario`.
    #[test_only]
    public fun test_init(ctx: &mut TxContext) { init(ctx); }

    fun key_bytes(job_id: ID, iter_n: u64): vector<u8> {
        let mut k = sui::bcs::to_bytes(&job_id);
        let it = sui::bcs::to_bytes(&iter_n);
        vector::append(&mut k, it);
        k
    }

    public entry fun request(
        _runner: &RunnerCap,
        reg: &mut CheckpointRegistry,
        job_id: ID,
        iter_n: u64,
        timeout_ms: u64,
        clock: &Clock,
    ) {
        let k = key_bytes(job_id, iter_n);
        assert!(!table::contains(&reg.items, k), EAlreadyExists);
        let cp = Checkpoint {
            job_id,
            iter_n,
            requested_at_ms: clock::timestamp_ms(clock),
            timeout_ms,
            approved_by: @0x0,
            approved_at_ms: 0,
            approved: false,
            timed_out: false,
        };
        table::add(&mut reg.items, k, cp);
        event::emit(CheckpointRequested { job_id, iter_n, timeout_ms });
    }

    /// Anyone can submit approval. Runner verifies buyer identity off-chain
    /// before it resumes the job — keeps this contract LoopJob-agnostic.
    public entry fun approve(
        reg: &mut CheckpointRegistry,
        job_id: ID,
        iter_n: u64,
        clock: &Clock,
        ctx: &TxContext,
    ) {
        let k = key_bytes(job_id, iter_n);
        assert!(table::contains(&reg.items, k), ENotFound);
        let cp = table::borrow_mut(&mut reg.items, k);
        assert!(!cp.approved && !cp.timed_out, EAlreadyDecided);
        cp.approved = true;
        cp.approved_by = ctx.sender();
        cp.approved_at_ms = clock::timestamp_ms(clock);
        event::emit(CheckpointApproved { job_id, iter_n, approved_by: ctx.sender() });
    }

    public entry fun mark_timed_out(
        reg: &mut CheckpointRegistry,
        job_id: ID,
        iter_n: u64,
        clock: &Clock,
    ) {
        let k = key_bytes(job_id, iter_n);
        assert!(table::contains(&reg.items, k), ENotFound);
        let cp = table::borrow_mut(&mut reg.items, k);
        assert!(!cp.approved && !cp.timed_out, EAlreadyDecided);
        let now = clock::timestamp_ms(clock);
        assert!(now >= cp.requested_at_ms + cp.timeout_ms, ENotYetTimedOut);
        cp.timed_out = true;
        event::emit(CheckpointTimedOut { job_id, iter_n });
    }

    public fun is_approved(reg: &CheckpointRegistry, job_id: ID, iter_n: u64): bool {
        let k = key_bytes(job_id, iter_n);
        if (!table::contains(&reg.items, k)) return false;
        table::borrow(&reg.items, k).approved
    }

    public fun is_timed_out(reg: &CheckpointRegistry, job_id: ID, iter_n: u64): bool {
        let k = key_bytes(job_id, iter_n);
        if (!table::contains(&reg.items, k)) return false;
        table::borrow(&reg.items, k).timed_out
    }
}
