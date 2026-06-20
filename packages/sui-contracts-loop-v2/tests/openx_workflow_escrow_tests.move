#[test_only]
module fhe_brain_loop_v2::openx_workflow_escrow_tests {
    use sui::test_scenario as ts;
    use sui::clock;
    use sui::coin;
    use sui::sui::SUI;
    use fhe_brain::openx_loop_agent_registry::{Self as ar, Agent, RunnerCap};
    use fhe_brain_loop_v2::openx_workflow_escrow::{Self as we, WorkflowEscrow};

    const SELLER: address = @0xA;
    const BUYER: address = @0xB;
    const RUNNER: address = @0xC;

    const RUN_PRICE: u64 = 50_000;     // 0.05 USDC equivalent in MIST

    // ─── Test scaffolding ────────────────────────────────────────────────

    /// Publish a default Agent so create_escrow has a referent.
    fun publish_default_agent(scn: &mut ts::Scenario) {
        let ctx = ts::ctx(scn);
        let mut clk = clock::create_for_testing(ctx);
        clock::set_for_testing(&mut clk, 1_000_000);
        ar::publish_agent(
            b"walrus_blob_manifest_v2",
            b"phala-tee",
            b"claude-opus-4.6",
            10_000,   // min 0.01 USDC
            RUN_PRICE,
            10,
            7000, 2500, 500,   // 70/25/5
            &clk, ctx,
        );
        clock::destroy_for_testing(clk);
    }

    /// Mint a buyer coin big enough for `runs` runs at the default RUN_PRICE.
    #[allow(unused_function)]
    fun buyer_coin(scn: &mut ts::Scenario, runs: u32): coin::Coin<SUI> {
        coin::mint_for_testing<SUI>((runs as u64) * RUN_PRICE, ts::ctx(scn))
    }

    /// Helper: create_escrow as buyer, default 7 runs at 02:00 UTC.
    fun create_default_escrow(scn: &mut ts::Scenario, runs: u32) {
        ts::next_tx(scn, BUYER);
        let agent = ts::take_shared<Agent>(scn);
        let ctx = ts::ctx(scn);
        let clk = clock::create_for_testing(ctx);
        let coin = coin::mint_for_testing<SUI>((runs as u64) * RUN_PRICE, ctx);
        we::create_escrow<SUI>(
            &agent,
            b"workflow_template_blob_v2",
            b"vietnam-ev-content",
            120, // 02:00 UTC
            runs,
            RUN_PRICE,
            coin,
            &clk,
            ctx,
        );
        clock::destroy_for_testing(clk);
        ts::return_shared(agent);
    }

    // ─── create_escrow ───────────────────────────────────────────────────

    #[test]
    fun create_escrow_records_inputs_and_balance() {
        let mut scn = ts::begin(SELLER);
        publish_default_agent(&mut scn);
        create_default_escrow(&mut scn, 7);

        ts::next_tx(&mut scn, BUYER);
        let esc = ts::take_shared<WorkflowEscrow<SUI>>(&scn);
        assert!(we::buyer<SUI>(&esc) == BUYER, 100);
        assert!(we::runs_remaining<SUI>(&esc) == 7, 101);
        assert!(we::max_per_run<SUI>(&esc) == RUN_PRICE, 102);
        assert!(we::escrow_remaining<SUI>(&esc) == 7 * RUN_PRICE, 103);
        assert!(we::total_escrowed<SUI>(&esc) == 7 * RUN_PRICE, 104);
        assert!(!we::is_cancelled<SUI>(&esc), 105);
        assert!(we::cron_utc_minute<SUI>(&esc) == 120, 106);
        ts::return_shared(esc);
        ts::end(scn);
    }

    #[test, expected_failure(abort_code = 4, location = we)]  // EBadCronMinute
    fun create_rejects_bad_cron_minute() {
        let mut scn = ts::begin(SELLER);
        publish_default_agent(&mut scn);
        ts::next_tx(&mut scn, BUYER);
        let agent = ts::take_shared<Agent>(&scn);
        let ctx = ts::ctx(&mut scn);
        let clk = clock::create_for_testing(ctx);
        let coin = coin::mint_for_testing<SUI>(7 * RUN_PRICE, ctx);
        we::create_escrow<SUI>(
            &agent, b"x", b"x",
            1500, 7, RUN_PRICE,  // 1500 >= 1440 → EBadCronMinute
            coin, &clk, ctx,
        );
        clock::destroy_for_testing(clk);
        ts::return_shared(agent);
        ts::end(scn);
    }

    #[test, expected_failure(abort_code = 5, location = we)]  // EBadRunCount
    fun create_rejects_zero_runs() {
        let mut scn = ts::begin(SELLER);
        publish_default_agent(&mut scn);
        ts::next_tx(&mut scn, BUYER);
        let agent = ts::take_shared<Agent>(&scn);
        let ctx = ts::ctx(&mut scn);
        let clk = clock::create_for_testing(ctx);
        let coin = coin::mint_for_testing<SUI>(0, ctx);
        we::create_escrow<SUI>(
            &agent, b"x", b"x",
            120, 0, RUN_PRICE,  // runs == 0 → EBadRunCount
            coin, &clk, ctx,
        );
        clock::destroy_for_testing(clk);
        ts::return_shared(agent);
        ts::end(scn);
    }

    #[test, expected_failure(abort_code = 3, location = we)]  // EInsufficientEscrow
    fun create_rejects_underfunded_coin() {
        let mut scn = ts::begin(SELLER);
        publish_default_agent(&mut scn);
        ts::next_tx(&mut scn, BUYER);
        let agent = ts::take_shared<Agent>(&scn);
        let ctx = ts::ctx(&mut scn);
        let clk = clock::create_for_testing(ctx);
        let coin = coin::mint_for_testing<SUI>(2 * RUN_PRICE, ctx);  // need 7
        we::create_escrow<SUI>(
            &agent, b"x", b"x",
            120, 7, RUN_PRICE,
            coin, &clk, ctx,
        );
        clock::destroy_for_testing(clk);
        ts::return_shared(agent);
        ts::end(scn);
    }

    // ─── fork_run ────────────────────────────────────────────────────────

    #[test]
    fun fork_run_drains_one_run_and_advances_schedule() {
        let mut scn = ts::begin(SELLER);
        publish_default_agent(&mut scn);
        create_default_escrow(&mut scn, 7);

        // Operator forks one run after `next_run_ts_ms`.
        ts::next_tx(&mut scn, RUNNER);
        let runner_cap = ar::mint_runner_cap_for_testing(ts::ctx(&mut scn));
        let mut esc = ts::take_shared<WorkflowEscrow<SUI>>(&scn);
        let next_ts = we::next_run_ts_ms<SUI>(&esc);
        let mut clk = clock::create_for_testing(ts::ctx(&mut scn));
        clock::set_for_testing(&mut clk, next_ts + 1);

        let coin = we::fork_run<SUI>(&runner_cap, &mut esc, &clk, ts::ctx(&mut scn));
        assert!(coin::value(&coin) == RUN_PRICE, 200);
        assert!(we::runs_remaining<SUI>(&esc) == 6, 201);
        assert!(we::escrow_remaining<SUI>(&esc) == 6 * RUN_PRICE, 202);
        assert!(we::next_run_ts_ms<SUI>(&esc) > next_ts, 203);

        // Burn the dust by transferring back to a sink address.
        coin::burn_for_testing(coin);
        clock::destroy_for_testing(clk);
        transfer::public_transfer(runner_cap, RUNNER);
        ts::return_shared(esc);
        ts::end(scn);
    }

    #[test, expected_failure(abort_code = 6, location = we)]  // ENotDue
    fun fork_run_aborts_when_not_due() {
        let mut scn = ts::begin(SELLER);
        publish_default_agent(&mut scn);
        create_default_escrow(&mut scn, 7);

        ts::next_tx(&mut scn, RUNNER);
        let runner_cap = ar::mint_runner_cap_for_testing(ts::ctx(&mut scn));
        let mut esc = ts::take_shared<WorkflowEscrow<SUI>>(&scn);
        let mut clk = clock::create_for_testing(ts::ctx(&mut scn));
        // Stay BEFORE next_run_ts_ms
        clock::set_for_testing(&mut clk, 0);

        let coin = we::fork_run<SUI>(&runner_cap, &mut esc, &clk, ts::ctx(&mut scn));
        coin::burn_for_testing(coin);
        clock::destroy_for_testing(clk);
        transfer::public_transfer(runner_cap, RUNNER);
        ts::return_shared(esc);
        ts::end(scn);
    }

    // ─── top_up ──────────────────────────────────────────────────────────

    #[test]
    fun top_up_grows_runs_and_balance() {
        let mut scn = ts::begin(SELLER);
        publish_default_agent(&mut scn);
        create_default_escrow(&mut scn, 2);

        // Top up +5 runs.
        ts::next_tx(&mut scn, BUYER);
        let mut esc = ts::take_shared<WorkflowEscrow<SUI>>(&scn);
        let coin = coin::mint_for_testing<SUI>(5 * RUN_PRICE, ts::ctx(&mut scn));
        we::top_up<SUI>(&mut esc, 5, coin, ts::ctx(&mut scn));
        assert!(we::runs_remaining<SUI>(&esc) == 7, 300);
        assert!(we::escrow_remaining<SUI>(&esc) == 7 * RUN_PRICE, 301);
        assert!(we::total_escrowed<SUI>(&esc) == 7 * RUN_PRICE, 302);
        ts::return_shared(esc);
        ts::end(scn);
    }

    #[test, expected_failure(abort_code = 7, location = we)]  // EBadTopUp
    fun top_up_rejects_underfunded_coin() {
        let mut scn = ts::begin(SELLER);
        publish_default_agent(&mut scn);
        create_default_escrow(&mut scn, 2);

        ts::next_tx(&mut scn, BUYER);
        let mut esc = ts::take_shared<WorkflowEscrow<SUI>>(&scn);
        let coin = coin::mint_for_testing<SUI>(RUN_PRICE, ts::ctx(&mut scn));  // 1 < 5
        we::top_up<SUI>(&mut esc, 5, coin, ts::ctx(&mut scn));
        ts::return_shared(esc);
        ts::end(scn);
    }

    #[test, expected_failure(abort_code = 7, location = we)]  // EBadTopUp
    fun top_up_rejects_zero_runs_to_add() {
        let mut scn = ts::begin(SELLER);
        publish_default_agent(&mut scn);
        create_default_escrow(&mut scn, 2);

        ts::next_tx(&mut scn, BUYER);
        let mut esc = ts::take_shared<WorkflowEscrow<SUI>>(&scn);
        let coin = coin::mint_for_testing<SUI>(0, ts::ctx(&mut scn));
        we::top_up<SUI>(&mut esc, 0, coin, ts::ctx(&mut scn));
        ts::return_shared(esc);
        ts::end(scn);
    }

    // ─── cancel_escrow ───────────────────────────────────────────────────

    #[test]
    fun cancel_refunds_balance_and_zeros_runs() {
        let mut scn = ts::begin(SELLER);
        publish_default_agent(&mut scn);
        create_default_escrow(&mut scn, 7);

        ts::next_tx(&mut scn, BUYER);
        let mut esc = ts::take_shared<WorkflowEscrow<SUI>>(&scn);
        let mut clk = clock::create_for_testing(ts::ctx(&mut scn));
        clock::set_for_testing(&mut clk, 1_000_000);  // realistic non-zero ts
        we::cancel_escrow<SUI>(&mut esc, &clk, ts::ctx(&mut scn));
        assert!(we::runs_remaining<SUI>(&esc) == 0, 400);
        assert!(we::escrow_remaining<SUI>(&esc) == 0, 401);
        assert!(we::is_cancelled<SUI>(&esc), 402);
        clock::destroy_for_testing(clk);
        ts::return_shared(esc);
        ts::end(scn);
    }

    #[test, expected_failure(abort_code = 0, location = we)]  // ENotBuyer
    fun cancel_rejects_non_buyer() {
        let mut scn = ts::begin(SELLER);
        publish_default_agent(&mut scn);
        create_default_escrow(&mut scn, 7);

        ts::next_tx(&mut scn, RUNNER);  // not the buyer
        let mut esc = ts::take_shared<WorkflowEscrow<SUI>>(&scn);
        let mut clk = clock::create_for_testing(ts::ctx(&mut scn));
        clock::set_for_testing(&mut clk, 1_000_000);
        we::cancel_escrow<SUI>(&mut esc, &clk, ts::ctx(&mut scn));
        clock::destroy_for_testing(clk);
        ts::return_shared(esc);
        ts::end(scn);
    }

    // ─── Lifecycle E2E (R1–R5) ──────────────────────────────────────────

    /// create → fork ×2 → top_up(+3) → fork ×3 → cancel → refund.
    /// Mirrors the buyer/seller user-story end-to-end.
    #[test]
    fun lifecycle_create_fork_topup_fork_cancel() {
        let mut scn = ts::begin(SELLER);
        publish_default_agent(&mut scn);
        create_default_escrow(&mut scn, 2);

        // 2 runs forked → escrow drained.
        ts::next_tx(&mut scn, RUNNER);
        let runner_cap = ar::mint_runner_cap_for_testing(ts::ctx(&mut scn));
        let mut esc = ts::take_shared<WorkflowEscrow<SUI>>(&scn);
        let mut clk = clock::create_for_testing(ts::ctx(&mut scn));
        let mut t = we::next_run_ts_ms<SUI>(&esc);

        clock::set_for_testing(&mut clk, t + 1);
        let c1 = we::fork_run<SUI>(&runner_cap, &mut esc, &clk, ts::ctx(&mut scn));
        coin::burn_for_testing(c1);

        t = we::next_run_ts_ms<SUI>(&esc);
        clock::set_for_testing(&mut clk, t + 1);
        let c2 = we::fork_run<SUI>(&runner_cap, &mut esc, &clk, ts::ctx(&mut scn));
        coin::burn_for_testing(c2);
        assert!(we::runs_remaining<SUI>(&esc) == 0, 500);
        assert!(we::escrow_remaining<SUI>(&esc) == 0, 501);

        // Buyer tops up +3.
        ts::next_tx(&mut scn, BUYER);
        let coin_top = coin::mint_for_testing<SUI>(3 * RUN_PRICE, ts::ctx(&mut scn));
        we::top_up<SUI>(&mut esc, 3, coin_top, ts::ctx(&mut scn));
        assert!(we::runs_remaining<SUI>(&esc) == 3, 502);
        assert!(we::escrow_remaining<SUI>(&esc) == 3 * RUN_PRICE, 503);
        assert!(we::total_escrowed<SUI>(&esc) == 5 * RUN_PRICE, 504);

        // Operator forks 1 more run, leaving 2 runs of escrow.
        ts::next_tx(&mut scn, RUNNER);
        t = we::next_run_ts_ms<SUI>(&esc);
        clock::set_for_testing(&mut clk, t + 1);
        let c3 = we::fork_run<SUI>(&runner_cap, &mut esc, &clk, ts::ctx(&mut scn));
        coin::burn_for_testing(c3);

        // Buyer cancels — 2 runs of escrow refunded.
        ts::next_tx(&mut scn, BUYER);
        we::cancel_escrow<SUI>(&mut esc, &clk, ts::ctx(&mut scn));
        assert!(we::is_cancelled<SUI>(&esc), 505);
        assert!(we::runs_remaining<SUI>(&esc) == 0, 506);
        assert!(we::escrow_remaining<SUI>(&esc) == 0, 507);

        clock::destroy_for_testing(clk);
        transfer::public_transfer(runner_cap, RUNNER);
        ts::return_shared(esc);
        ts::end(scn);
    }
}
