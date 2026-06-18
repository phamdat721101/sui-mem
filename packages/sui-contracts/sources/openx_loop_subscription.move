/// openx_loop_subscription — daily-run / recurring workflow subscription.
///
/// THE NEW v1.1+ primitive on top of PRD-W. Buyer signs ONE PTB to escrow
/// `N × max_per_run` USDC into a shared `LoopSubscription<T>` object that
/// wraps a workflow YAML template + `cron_utc_minute` + `runs_remaining`.
/// At each scheduled tick the operator (RunnerCap holder) calls `fork_run`
/// which deducts one run's budget from the embedded escrow. Buyer can
/// `cancel_subscription` any time → unused balance refunded atomically.
///
/// SOLID:
///   - SRP: this module owns recurring-escrow + run forking. The actual
///     job lifecycle stays in `openx_loop_job` — `fork_run` returns a
///     `Coin<T>` that the operator passes into `openx_loop_job::new_job`
///     in the same PTB. No friend-only coupling needed.
///   - DIP: `RUNNER_CAP` from `openx_loop_agent_registry` gates `fork_run`.
///   - Existing 6 openx_loop_* modules byte-identical (PRD-W invariant).
module fhe_brain::openx_loop_subscription {
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

    const MAX_RUNS_HARD_CAP: u32 = 366; // one year of daily runs

    // ─── Object ──────────────────────────────────────────────────────────

    /// Recurring workflow subscription — shared object.
    ///
    /// Lives in canonical state on Sui; Postgres `loop_subscriptions` is a
    /// hot-path operational mirror used by the off-chain scheduler cron.
    public struct LoopSubscription<phantom T> has key {
        id: UID,
        buyer: address,
        agent_id: ID,
        /// Walrus blob id for the workflow YAML template forked per run.
        template_walrus_blob_id: String,
        /// Optional area_slug for warm-context filtering.
        area_slug: String,
        /// Minute-of-day UTC (0..1439) when each run fires.
        cron_utc_minute: u32,
        /// Decremented each successful `fork_run`. 0 → subscription exhausted.
        runs_remaining: u32,
        /// Cap on per-run spend; protects against runaway budget.
        max_per_run_micro: u64,
        /// Pre-funded budget. Drains by `max_per_run_micro` per `fork_run`.
        escrow: Balance<T>,
        /// Next epoch-ms when scheduler should fork. Updated post fork_run.
        next_run_ts_ms: u64,
        last_run_ts_ms: u64,
        cancelled_at_ms: u64,
        created_at_ms: u64,
    }

    // ─── Events ──────────────────────────────────────────────────────────

    public struct SubscriptionCreated has copy, drop {
        sub_id: ID,
        buyer: address,
        agent_id: ID,
        runs_remaining: u32,
        cron_utc_minute: u32,
        max_per_run_micro: u64,
        total_escrow_micro: u64,
    }

    public struct SubscriptionRunForked has copy, drop {
        sub_id: ID,
        run_seq: u32,        // 1-based counter of the run just forked
        amount_micro: u64,
        runs_remaining_after: u32,
        ts_ms: u64,
    }

    public struct SubscriptionCancelled has copy, drop {
        sub_id: ID,
        buyer: address,
        refunded_micro: u64,
        runs_left: u32,
    }

    // ─── Construction (buyer-signed PTB) ─────────────────────────────────

    /// Buyer-signed entry — escrows `runs × max_per_run` USDC into a fresh
    /// LoopSubscription shared object.
    public entry fun create_subscription<T>(
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
        let sub = LoopSubscription<T> {
            id: object::new(ctx),
            buyer: ctx.sender(),
            agent_id: object::id(agent),
            template_walrus_blob_id: string::utf8(template_walrus_blob_id),
            area_slug: string::utf8(area_slug),
            cron_utc_minute,
            runs_remaining: runs,
            max_per_run_micro,
            escrow: coin::into_balance(budget_coin),
            next_run_ts_ms: compute_next_run_ms(now_ms, cron_utc_minute),
            last_run_ts_ms: 0,
            cancelled_at_ms: 0,
            created_at_ms: now_ms,
        };

        event::emit(SubscriptionCreated {
            sub_id: object::id(&sub),
            buyer: sub.buyer,
            agent_id: sub.agent_id,
            runs_remaining: sub.runs_remaining,
            cron_utc_minute,
            max_per_run_micro,
            total_escrow_micro: total,
        });

        transfer::share_object(sub);
    }

    // ─── Operator-gated fork_run ─────────────────────────────────────────

    /// Operator (RunnerCap holder) draws one run's budget from escrow as a
    /// Coin<T> the caller can pass into `openx_loop_job::new_job` in the
    /// same PTB. Decrements `runs_remaining` and advances `next_run_ts_ms`.
    public fun fork_run<T>(
        _runner: &RunnerCap,
        sub: &mut LoopSubscription<T>,
        clock: &Clock,
        ctx: &mut TxContext,
    ): Coin<T> {
        assert!(sub.cancelled_at_ms == 0, EAlreadyCancelled);
        assert!(sub.runs_remaining > 0, ENoRunsRemaining);
        let now_ms = clock::timestamp_ms(clock);
        assert!(now_ms >= sub.next_run_ts_ms, ENotDue);
        assert!(balance::value(&sub.escrow) >= sub.max_per_run_micro, EInsufficientEscrow);

        let coin_out = coin::from_balance(
            balance::split(&mut sub.escrow, sub.max_per_run_micro),
            ctx,
        );

        sub.runs_remaining = sub.runs_remaining - 1;
        sub.last_run_ts_ms = now_ms;
        sub.next_run_ts_ms = compute_next_run_ms(now_ms, sub.cron_utc_minute);

        event::emit(SubscriptionRunForked {
            sub_id: object::id(sub),
            run_seq: ((MAX_RUNS_HARD_CAP - sub.runs_remaining) as u32),
            amount_micro: sub.max_per_run_micro,
            runs_remaining_after: sub.runs_remaining,
            ts_ms: now_ms,
        });

        coin_out
    }

    // ─── Buyer-controlled cancel ─────────────────────────────────────────

    /// Atomic cancel — refunds remaining escrow to buyer.
    public entry fun cancel_subscription<T>(
        sub: &mut LoopSubscription<T>,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(sub.buyer == ctx.sender(), ENotBuyer);
        assert!(sub.cancelled_at_ms == 0, EAlreadyCancelled);

        let remaining = balance::value(&sub.escrow);
        let runs_left = sub.runs_remaining;
        if (remaining > 0) {
            let coin = coin::from_balance(balance::split(&mut sub.escrow, remaining), ctx);
            transfer::public_transfer(coin, sub.buyer);
        };
        sub.cancelled_at_ms = clock::timestamp_ms(clock);
        sub.runs_remaining = 0;

        event::emit(SubscriptionCancelled {
            sub_id: object::id(sub),
            buyer: sub.buyer,
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

    // ─── Read accessors ─────────────────────────────────────────────────

    public fun buyer<T>(s: &LoopSubscription<T>): address { s.buyer }
    public fun agent_id<T>(s: &LoopSubscription<T>): ID { s.agent_id }
    public fun runs_remaining<T>(s: &LoopSubscription<T>): u32 { s.runs_remaining }
    public fun max_per_run<T>(s: &LoopSubscription<T>): u64 { s.max_per_run_micro }
    public fun escrow_remaining<T>(s: &LoopSubscription<T>): u64 { balance::value(&s.escrow) }
    public fun is_cancelled<T>(s: &LoopSubscription<T>): bool { s.cancelled_at_ms > 0 }
    public fun next_run_ts_ms<T>(s: &LoopSubscription<T>): u64 { s.next_run_ts_ms }
    public fun cron_utc_minute<T>(s: &LoopSubscription<T>): u32 { s.cron_utc_minute }
    public fun template_blob_id<T>(s: &LoopSubscription<T>): &String { &s.template_walrus_blob_id }
    public fun area_slug<T>(s: &LoopSubscription<T>): &String { &s.area_slug }
}
