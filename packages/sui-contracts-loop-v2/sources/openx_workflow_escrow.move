/// openx_workflow_escrow — v2 buyer-deposit-on-hire workflow escrow.
///
/// PRD `workflow-escrow` ships this as a sibling package to `fhe_brain`.
/// The v1 module `openx_loop_subscription::LoopSubscription<T>` stays in
/// place for legacy subs; new hires use `WorkflowEscrow<T>` here.
///
/// Adds the missing primitive vs v1: `top_up` — buyer extends an active
/// escrow with extra runs. Without this, an out-of-budget escrow forced
/// the buyer to cancel and recreate.
///
/// Status semantics (PRD decision 2=a): "stopped" is **derived off-chain**
/// from `escrow_remaining < max_per_run AND !cancelled`. No new on-chain
/// event is required — the existing `EscrowRunForked.escrow_remaining_after`
/// is enough for the indexer/scheduler to know when fork_run will start
/// failing with `EInsufficientEscrow`.
///
/// SOLID:
///   - SRP: this module owns deposit + fork + top_up + cancel. Job lifecycle
///     (`openx_loop_job`) is unchanged — fork_run returns Coin<T> the
///     operator passes into the existing job-creation PTB.
///   - DIP: type identity for `Agent` and `RunnerCap` flows from the
///     existing `fhe_brain` package via Move.toml dep — no duplication.
///   - OCP: schedule, max_per_run cap, and fund accounting are independent
///     dimensions. A new dimension (e.g. seller-side bond) would be a new
///     field, not a rewrite.
module fhe_brain_loop_v2::openx_workflow_escrow {
    use sui::event;
    use sui::balance::{Self, Balance};
    use sui::coin::{Self, Coin};
    use sui::clock::{Self, Clock};
    use std::string::{Self, String};
    use fhe_brain::openx_loop_agent_registry::{Agent, RunnerCap};

    // ─── Errors ──────────────────────────────────────────────────────────

    const ENotBuyer: u64 = 0;
    const EAlreadyCancelled: u64 = 1;
    const ENoRunsRemaining: u64 = 2;
    const EInsufficientEscrow: u64 = 3;
    const EBadCronMinute: u64 = 4;
    const EBadRunCount: u64 = 5;
    const ENotDue: u64 = 6;
    const EBadTopUp: u64 = 7;

    const MAX_RUNS_HARD_CAP: u32 = 366; // one year of daily runs

    // ─── Object ──────────────────────────────────────────────────────────

    /// Workflow escrow — shared object.
    ///
    /// Lives in canonical state on Sui; Postgres `loop_subscriptions` is the
    /// hot-path operational mirror used by the scheduler cron + indexer.
    /// Field shape is *intentionally identical* to v1's LoopSubscription
    /// where overlapping, with two additions:
    ///   - `total_escrowed_micro` — informational; sum of initial + every
    ///     top_up. Drives the seller's "lifetime committed" view.
    ///   - The module name + package id differ; status fan-out happens at
    ///     the indexer level (`package_version` column in Postgres).
    public struct WorkflowEscrow<phantom T> has key {
        id: UID,
        buyer: address,
        agent_id: ID,
        /// Walrus blob id for the workflow YAML template forked per run.
        template_walrus_blob_id: String,
        /// Optional area_slug for warm-context filtering.
        area_slug: String,
        /// Minute-of-day UTC (0..1439) when each run fires.
        cron_utc_minute: u32,
        /// Decremented each successful `fork_run`. Bumped by `top_up`.
        runs_remaining: u32,
        /// Cap on per-run spend; protects against runaway budget.
        max_per_run_micro: u64,
        /// Live escrow. Drains by `max_per_run_micro` per `fork_run`,
        /// grows by top_up, fully refunds on cancel.
        escrow: Balance<T>,
        /// Cumulative — initial + every top_up. Never decrements.
        /// Powers the seller-side "lifetime committed" view.
        total_escrowed_micro: u64,
        /// Next epoch-ms when scheduler should fork. Updated post fork_run.
        next_run_ts_ms: u64,
        last_run_ts_ms: u64,
        cancelled_at_ms: u64,
        created_at_ms: u64,
    }

    // ─── Events ──────────────────────────────────────────────────────────

    public struct EscrowCreated has copy, drop {
        escrow_id: ID,
        buyer: address,
        agent_id: ID,
        runs_remaining: u32,
        cron_utc_minute: u32,
        max_per_run_micro: u64,
        total_escrow_micro: u64,
    }

    public struct EscrowRunForked has copy, drop {
        escrow_id: ID,
        run_seq: u32,
        amount_micro: u64,
        runs_remaining_after: u32,
        escrow_remaining_after: u64,
        ts_ms: u64,
    }

    public struct EscrowToppedUp has copy, drop {
        escrow_id: ID,
        buyer: address,
        added_runs: u32,
        added_micro: u64,
        runs_remaining_after: u32,
        escrow_remaining_after: u64,
        total_escrowed_micro_after: u64,
    }

    public struct EscrowCancelled has copy, drop {
        escrow_id: ID,
        buyer: address,
        refunded_micro: u64,
        runs_left: u32,
    }

    // ─── Construction (buyer-signed PTB) ─────────────────────────────────

    /// Buyer-signed entry — escrows `runs × max_per_run` USDC into a fresh
    /// WorkflowEscrow shared object.
    public entry fun create_escrow<T>(
        agent: &Agent,
        template_walrus_blob_id: vector<u8>,
        area_slug: vector<u8>,
        cron_utc_minute: u32,
        runs: u32,
        max_per_run_micro: u64,
        budget_coin: Coin<T>,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(cron_utc_minute < 1440, EBadCronMinute);
        assert!(runs > 0 && runs <= MAX_RUNS_HARD_CAP, EBadRunCount);
        let total = (runs as u64) * max_per_run_micro;
        assert!(coin::value(&budget_coin) >= total, EInsufficientEscrow);

        let now_ms = clock::timestamp_ms(clock);
        let escrow = WorkflowEscrow<T> {
            id: object::new(ctx),
            buyer: ctx.sender(),
            agent_id: object::id(agent),
            template_walrus_blob_id: string::utf8(template_walrus_blob_id),
            area_slug: string::utf8(area_slug),
            cron_utc_minute,
            runs_remaining: runs,
            max_per_run_micro,
            escrow: coin::into_balance(budget_coin),
            total_escrowed_micro: total,
            next_run_ts_ms: compute_next_run_ms(now_ms, cron_utc_minute),
            last_run_ts_ms: 0,
            cancelled_at_ms: 0,
            created_at_ms: now_ms,
        };

        event::emit(EscrowCreated {
            escrow_id: object::id(&escrow),
            buyer: escrow.buyer,
            agent_id: escrow.agent_id,
            runs_remaining: escrow.runs_remaining,
            cron_utc_minute,
            max_per_run_micro,
            total_escrow_micro: total,
        });

        transfer::share_object(escrow);
    }

    // ─── Operator-gated fork_run ─────────────────────────────────────────

    /// Operator (RunnerCap holder) draws one run's budget from escrow as a
    /// Coin<T> the caller can pass into `openx_loop_job::new_job` in the
    /// same PTB. Decrements `runs_remaining` and advances `next_run_ts_ms`.
    public fun fork_run<T>(
        _runner: &RunnerCap,
        esc: &mut WorkflowEscrow<T>,
        clock: &Clock,
        ctx: &mut TxContext,
    ): Coin<T> {
        assert!(esc.cancelled_at_ms == 0, EAlreadyCancelled);
        assert!(esc.runs_remaining > 0, ENoRunsRemaining);
        let now_ms = clock::timestamp_ms(clock);
        assert!(now_ms >= esc.next_run_ts_ms, ENotDue);
        assert!(balance::value(&esc.escrow) >= esc.max_per_run_micro, EInsufficientEscrow);

        let coin_out = coin::from_balance(
            balance::split(&mut esc.escrow, esc.max_per_run_micro),
            ctx,
        );

        esc.runs_remaining = esc.runs_remaining - 1;
        esc.last_run_ts_ms = now_ms;
        esc.next_run_ts_ms = compute_next_run_ms(now_ms, esc.cron_utc_minute);

        event::emit(EscrowRunForked {
            escrow_id: object::id(esc),
            run_seq: ((MAX_RUNS_HARD_CAP - esc.runs_remaining) as u32),
            amount_micro: esc.max_per_run_micro,
            runs_remaining_after: esc.runs_remaining,
            escrow_remaining_after: balance::value(&esc.escrow),
            ts_ms: now_ms,
        });

        coin_out
    }

    // ─── Buyer-signed top_up ─────────────────────────────────────────────

    /// Adds `runs_to_add` runs of budget to an active escrow. Buyer must
    /// supply a coin worth at least `runs_to_add * max_per_run_micro`;
    /// excess MUST be split off by the caller's PTB before this call (we
    /// keep this entry simple — Coin<T> lacks `drop`, splitting here would
    /// force returning a remainder which complicates the FE flow).
    ///
    /// Schedule (`next_run_ts_ms`, `cron_utc_minute`) is unchanged — top_up
    /// only refills budget; it doesn't reset the cadence.
    public entry fun top_up<T>(
        esc: &mut WorkflowEscrow<T>,
        runs_to_add: u32,
        additional_budget: Coin<T>,
        ctx: &mut TxContext,
    ) {
        assert!(esc.cancelled_at_ms == 0, EAlreadyCancelled);
        assert!(runs_to_add > 0, EBadTopUp);
        let added_value = coin::value(&additional_budget);
        let needed = (runs_to_add as u64) * esc.max_per_run_micro;
        assert!(added_value >= needed, EBadTopUp);
        assert!(esc.buyer == ctx.sender(), ENotBuyer);

        balance::join(&mut esc.escrow, coin::into_balance(additional_budget));
        esc.runs_remaining = esc.runs_remaining + runs_to_add;
        esc.total_escrowed_micro = esc.total_escrowed_micro + added_value;

        event::emit(EscrowToppedUp {
            escrow_id: object::id(esc),
            buyer: esc.buyer,
            added_runs: runs_to_add,
            added_micro: added_value,
            runs_remaining_after: esc.runs_remaining,
            escrow_remaining_after: balance::value(&esc.escrow),
            total_escrowed_micro_after: esc.total_escrowed_micro,
        });
    }

    // ─── Buyer-controlled cancel ─────────────────────────────────────────

    /// Atomic cancel — refunds the entire remaining escrow to the buyer.
    /// Idempotent: a second call aborts with EAlreadyCancelled.
    public entry fun cancel_escrow<T>(
        esc: &mut WorkflowEscrow<T>,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(esc.buyer == ctx.sender(), ENotBuyer);
        assert!(esc.cancelled_at_ms == 0, EAlreadyCancelled);

        let remaining = balance::value(&esc.escrow);
        let runs_left = esc.runs_remaining;
        if (remaining > 0) {
            let coin = coin::from_balance(balance::split(&mut esc.escrow, remaining), ctx);
            transfer::public_transfer(coin, esc.buyer);
        };
        esc.cancelled_at_ms = clock::timestamp_ms(clock);
        esc.runs_remaining = 0;

        event::emit(EscrowCancelled {
            escrow_id: object::id(esc),
            buyer: esc.buyer,
            refunded_micro: remaining,
            runs_left,
        });
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    /// Pure: same `cron_utc_minute` tomorrow (next 24-hour boundary).
    fun compute_next_run_ms(now_ms: u64, cron_utc_minute: u32): u64 {
        let day_ms: u64 = 86_400_000;
        let minute_offset_ms: u64 = (cron_utc_minute as u64) * 60_000;
        let today_start = now_ms - (now_ms % day_ms);
        let candidate = today_start + minute_offset_ms;
        if (candidate <= now_ms) {
            candidate + day_ms
        } else {
            candidate
        }
    }

    // ─── Read accessors (off-chain consumers) ───────────────────────────

    public fun buyer<T>(e: &WorkflowEscrow<T>): address { e.buyer }
    public fun agent_id<T>(e: &WorkflowEscrow<T>): ID { e.agent_id }
    public fun runs_remaining<T>(e: &WorkflowEscrow<T>): u32 { e.runs_remaining }
    public fun max_per_run<T>(e: &WorkflowEscrow<T>): u64 { e.max_per_run_micro }
    public fun escrow_remaining<T>(e: &WorkflowEscrow<T>): u64 { balance::value(&e.escrow) }
    public fun total_escrowed<T>(e: &WorkflowEscrow<T>): u64 { e.total_escrowed_micro }
    public fun is_cancelled<T>(e: &WorkflowEscrow<T>): bool { e.cancelled_at_ms > 0 }
    public fun next_run_ts_ms<T>(e: &WorkflowEscrow<T>): u64 { e.next_run_ts_ms }
    public fun cron_utc_minute<T>(e: &WorkflowEscrow<T>): u32 { e.cron_utc_minute }
    public fun template_blob_id<T>(e: &WorkflowEscrow<T>): &String { &e.template_walrus_blob_id }
    public fun area_slug<T>(e: &WorkflowEscrow<T>): &String { &e.area_slug }
}
