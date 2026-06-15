/// openx_loop_job_factory — Mode B hire entrypoint.
///
/// One `entry fun create<T>` consumes the buyer's `Coin<T>` and spawns a
/// `LoopJob<T>` shared object in a single tx. Replaces arb-mem's
/// `LoopJobFactory.createWithPermit2` — Sui's coin model + sponsored tx
/// already give us "one signature, atomic spawn" without Permit2.
///
/// SOLID:
///   - SRP: factory only — no escrow logic, no settlement.
///   - DIP: agent + clock injected; nothing module-level.
module fhe_brain::openx_loop_job_factory {
    use sui::clock::Clock;
    use sui::coin::Coin;
    use fhe_brain::openx_loop_agent_registry::{Self as ar, Agent};
    use fhe_brain::openx_loop_job::{Self as job};

    const EAgentRevoked: u64 = 0;
    const EMaxIterTooLarge: u64 = 1;

    /// Buyer entry: hire an agent for `max_iterations` with `budget_coin`.
    /// `ctx.sender()` becomes the LoopJob.buyer regardless of gas owner —
    /// safe under Sui sponsored tx.
    public entry fun create<T>(
        agent: &Agent,
        max_iterations: u64,
        budget_coin: Coin<T>,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(!ar::is_revoked(agent), EAgentRevoked);
        assert!(max_iterations > 0 && max_iterations <= ar::max_iter(agent), EMaxIterTooLarge);

        let new_job = job::new_job<T>(ctx.sender(), agent, max_iterations, budget_coin, clock, ctx);
        job::share<T>(new_job);
    }
}
