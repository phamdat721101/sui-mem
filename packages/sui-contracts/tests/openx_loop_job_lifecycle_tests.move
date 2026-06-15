#[test_only]
module fhe_brain::openx_loop_job_lifecycle_tests {
    use sui::test_scenario as ts;
    use sui::clock;
    use sui::coin;
    use sui::sui::SUI;
    use fhe_brain::openx_loop_agent_registry::{Self as ar, Agent};
    use fhe_brain::openx_loop_job::{Self as job, LoopJob};
    use fhe_brain::openx_loop_job_factory as f;
    use fhe_brain::openx_loop_checkpoint::{Self as cp, CheckpointRegistry};

    const SELLER: address = @0xA;
    const BUYER: address = @0xB;
    const COMPUTE: address = @0xC1;
    const PLATFORM: address = @0xC2;
    const RUNNER: address = @0xC3;

    fun publish_default(scn: &mut ts::Scenario) {
        let ctx = ts::ctx(scn);
        let mut clk = clock::create_for_testing(ctx);
        clock::set_for_testing(&mut clk, 1_000_000);
        ar::publish_agent(
            b"manifest_blob_loopB",
            b"phala-tee", b"claude-opus-4.6",
            10_000, 50_000, 5,        // max 5 iters
            7000, 2500, 500,
            &clk, ctx,
        );
        clock::destroy_for_testing(clk);
    }

    fun hire_3_iters(scn: &mut ts::Scenario, budget_micro: u64) {
        ts::next_tx(scn, BUYER);
        let agent = ts::take_shared<Agent>(scn);
        let ctx = ts::ctx(scn);
        let clk = clock::create_for_testing(ctx);
        let budget = coin::mint_for_testing<SUI>(budget_micro, ctx);
        f::create<SUI>(&agent, 3, budget, &clk, ctx);
        clock::destroy_for_testing(clk);
        ts::return_shared(agent);
    }

    #[test]
    fun create_job_funds_escrow() {
        let mut scn = ts::begin(SELLER);
        publish_default(&mut scn);
        hire_3_iters(&mut scn, 150_000); // 3 × 50k

        ts::next_tx(&mut scn, BUYER);
        let job = ts::take_shared<LoopJob<SUI>>(&scn);
        assert!(job::buyer(&job) == BUYER, 100);
        assert!(job::escrow_remaining(&job) == 150_000, 101);
        assert!(job::status(&job) == job::status_running(), 102);
        assert!(job::iterations_done(&job) == 0, 103);
        assert!(job::max_iterations(&job) == 3, 104);
        ts::return_shared(job);
        ts::end(scn);
    }

    #[test]
    fun advance_iter_with_split_70_25_5() {
        let mut scn = ts::begin(SELLER);
        publish_default(&mut scn);
        hire_3_iters(&mut scn, 150_000);

        ts::next_tx(&mut scn, RUNNER);
        let runner_cap = ar::mint_runner_cap_for_testing(ts::ctx(&mut scn));
        let mut j = ts::take_shared<LoopJob<SUI>>(&scn);
        let agent = ts::take_shared<Agent>(&scn);
        let ctx = ts::ctx(&mut scn);
        let mut clk = clock::create_for_testing(ctx);
        clock::set_for_testing(&mut clk, 2_000_000);
        job::advance_iter_with_split<SUI>(
            &runner_cap, &mut j, &agent,
            1, b"walrus_iter_1_blob", b"attest_hash_1",
            50_000,
            COMPUTE, PLATFORM,
            &clk, ctx,
        );
        clock::destroy_for_testing(clk);

        assert!(job::iterations_done(&j) == 1, 200);
        assert!(job::spent_micro(&j) == 50_000, 201);
        assert!(job::escrow_remaining(&j) == 100_000, 202);

        ar::destroy_runner_cap_for_testing(runner_cap);
        ts::return_shared(j);
        ts::return_shared(agent);

        ts::next_tx(&mut scn, SELLER);
        {
            let c = ts::take_from_address<coin::Coin<SUI>>(&scn, SELLER);
            assert!(coin::value(&c) == 35_000, 203); // 50k * 7000/10000
            ts::return_to_address(SELLER, c);
        };
        {
            let c = ts::take_from_address<coin::Coin<SUI>>(&scn, COMPUTE);
            assert!(coin::value(&c) == 12_500, 204); // 50k * 2500/10000
            ts::return_to_address(COMPUTE, c);
        };
        {
            let c = ts::take_from_address<coin::Coin<SUI>>(&scn, PLATFORM);
            assert!(coin::value(&c) == 2_500, 205); // 50k - 35k - 12.5k
            ts::return_to_address(PLATFORM, c);
        };
        ts::end(scn);
    }

    #[test, expected_failure(abort_code = 4, location = job)]
    fun advance_wrong_iter_n_aborts() {
        let mut scn = ts::begin(SELLER);
        publish_default(&mut scn);
        hire_3_iters(&mut scn, 150_000);

        ts::next_tx(&mut scn, RUNNER);
        let runner_cap = ar::mint_runner_cap_for_testing(ts::ctx(&mut scn));
        let mut j = ts::take_shared<LoopJob<SUI>>(&scn);
        let agent = ts::take_shared<Agent>(&scn);
        let ctx = ts::ctx(&mut scn);
        let clk = clock::create_for_testing(ctx);
        // iter 2 before iter 1 — EWrongIterN=4
        job::advance_iter_with_split<SUI>(
            &runner_cap, &mut j, &agent,
            2, b"walrus_iter_2", b"attest_2",
            50_000, COMPUTE, PLATFORM, &clk, ctx,
        );
        clock::destroy_for_testing(clk);
        ar::destroy_runner_cap_for_testing(runner_cap);
        ts::return_shared(j);
        ts::return_shared(agent);
        ts::end(scn);
    }

    #[test, expected_failure(abort_code = 2, location = job)]
    fun advance_exceeds_budget_aborts() {
        let mut scn = ts::begin(SELLER);
        publish_default(&mut scn);
        hire_3_iters(&mut scn, 150_000);

        ts::next_tx(&mut scn, RUNNER);
        let runner_cap = ar::mint_runner_cap_for_testing(ts::ctx(&mut scn));
        let mut j = ts::take_shared<LoopJob<SUI>>(&scn);
        let agent = ts::take_shared<Agent>(&scn);
        let ctx = ts::ctx(&mut scn);
        let clk = clock::create_for_testing(ctx);
        // 200k > 150k budget — EBudgetExceeded=2
        job::advance_iter_with_split<SUI>(
            &runner_cap, &mut j, &agent,
            1, b"blob", b"attest",
            200_000, COMPUTE, PLATFORM, &clk, ctx,
        );
        clock::destroy_for_testing(clk);
        ar::destroy_runner_cap_for_testing(runner_cap);
        ts::return_shared(j);
        ts::return_shared(agent);
        ts::end(scn);
    }

    #[test]
    fun pause_resume_lifecycle() {
        let mut scn = ts::begin(SELLER);
        publish_default(&mut scn);
        hire_3_iters(&mut scn, 150_000);

        ts::next_tx(&mut scn, BUYER);
        let mut j = ts::take_shared<LoopJob<SUI>>(&scn);
        let ctx = ts::ctx(&mut scn);
        job::pause<SUI>(&mut j, ctx);
        assert!(job::status(&j) == job::status_paused_budget(), 400);
        job::resume<SUI>(&mut j, ctx);
        assert!(job::status(&j) == job::status_running(), 401);
        ts::return_shared(j);
        ts::end(scn);
    }

    #[test]
    fun cancel_refunds_residual_to_buyer() {
        let mut scn = ts::begin(SELLER);
        publish_default(&mut scn);
        hire_3_iters(&mut scn, 150_000);

        // Advance 1 iter → spent 50k, escrow 100k.
        ts::next_tx(&mut scn, RUNNER);
        let runner_cap = ar::mint_runner_cap_for_testing(ts::ctx(&mut scn));
        let mut j = ts::take_shared<LoopJob<SUI>>(&scn);
        let agent = ts::take_shared<Agent>(&scn);
        let ctx = ts::ctx(&mut scn);
        let clk = clock::create_for_testing(ctx);
        job::advance_iter_with_split<SUI>(
            &runner_cap, &mut j, &agent, 1, b"b", b"a",
            50_000, COMPUTE, PLATFORM, &clk, ctx,
        );
        clock::destroy_for_testing(clk);
        ar::destroy_runner_cap_for_testing(runner_cap);
        ts::return_shared(agent);
        ts::return_shared(j);

        // Buyer cancels → 100k refund.
        ts::next_tx(&mut scn, BUYER);
        let mut j = ts::take_shared<LoopJob<SUI>>(&scn);
        let ctx = ts::ctx(&mut scn);
        let clk = clock::create_for_testing(ctx);
        job::cancel<SUI>(&mut j, &clk, ctx);
        assert!(job::status(&j) == job::status_cancelled(), 500);
        assert!(job::escrow_remaining(&j) == 0, 501);
        clock::destroy_for_testing(clk);
        ts::return_shared(j);

        ts::next_tx(&mut scn, BUYER);
        {
            let c = ts::take_from_address<coin::Coin<SUI>>(&scn, BUYER);
            assert!(coin::value(&c) == 100_000, 502);
            ts::return_to_address(BUYER, c);
        };
        ts::end(scn);
    }

    #[test]
    fun complete_refunds_residual_to_buyer() {
        let mut scn = ts::begin(SELLER);
        publish_default(&mut scn);
        hire_3_iters(&mut scn, 150_000);

        ts::next_tx(&mut scn, RUNNER);
        let runner_cap = ar::mint_runner_cap_for_testing(ts::ctx(&mut scn));
        let mut j = ts::take_shared<LoopJob<SUI>>(&scn);
        let agent = ts::take_shared<Agent>(&scn);
        let ctx = ts::ctx(&mut scn);
        let clk = clock::create_for_testing(ctx);
        job::advance_iter_with_split<SUI>(
            &runner_cap, &mut j, &agent, 1, b"b", b"a",
            50_000, COMPUTE, PLATFORM, &clk, ctx,
        );
        // Runner short-circuits — calls complete with 100k unspent.
        job::complete<SUI>(&runner_cap, &mut j, &clk, ctx);
        assert!(job::status(&j) == job::status_done(), 600);
        clock::destroy_for_testing(clk);
        ar::destroy_runner_cap_for_testing(runner_cap);
        ts::return_shared(agent);
        ts::return_shared(j);

        ts::next_tx(&mut scn, BUYER);
        {
            let c = ts::take_from_address<coin::Coin<SUI>>(&scn, BUYER);
            assert!(coin::value(&c) == 100_000, 601);
            ts::return_to_address(BUYER, c);
        };
        ts::end(scn);
    }

    // ─── Checkpoint module ───────────────────────────────────────────────

    fun init_checkpoint_reg(scn: &mut ts::Scenario) {
        ts::next_tx(scn, SELLER);
        cp::test_init(ts::ctx(scn));
    }

    #[test]
    fun checkpoint_request_approve_happy_path() {
        let mut scn = ts::begin(SELLER);
        publish_default(&mut scn);
        hire_3_iters(&mut scn, 150_000);
        init_checkpoint_reg(&mut scn);

        ts::next_tx(&mut scn, BUYER);
        let j = ts::take_shared<LoopJob<SUI>>(&scn);
        let job_id = object::id(&j);
        ts::return_shared(j);

        ts::next_tx(&mut scn, RUNNER);
        let runner_cap = ar::mint_runner_cap_for_testing(ts::ctx(&mut scn));
        let mut reg = ts::take_shared<CheckpointRegistry>(&scn);
        let ctx = ts::ctx(&mut scn);
        let mut clk = clock::create_for_testing(ctx);
        clock::set_for_testing(&mut clk, 5_000_000);
        cp::request(&runner_cap, &mut reg, job_id, 1, 60_000, &clk);

        ts::next_tx(&mut scn, BUYER);
        let ctx = ts::ctx(&mut scn);
        cp::approve(&mut reg, job_id, 1, &clk, ctx);
        assert!(cp::is_approved(&reg, job_id, 1), 700);
        assert!(!cp::is_timed_out(&reg, job_id, 1), 701);

        clock::destroy_for_testing(clk);
        ar::destroy_runner_cap_for_testing(runner_cap);
        ts::return_shared(reg);
        ts::end(scn);
    }

    #[test]
    fun checkpoint_timeout_after_deadline() {
        let mut scn = ts::begin(SELLER);
        publish_default(&mut scn);
        hire_3_iters(&mut scn, 150_000);
        init_checkpoint_reg(&mut scn);

        ts::next_tx(&mut scn, BUYER);
        let j = ts::take_shared<LoopJob<SUI>>(&scn);
        let job_id = object::id(&j);
        ts::return_shared(j);

        ts::next_tx(&mut scn, RUNNER);
        let runner_cap = ar::mint_runner_cap_for_testing(ts::ctx(&mut scn));
        let mut reg = ts::take_shared<CheckpointRegistry>(&scn);
        let ctx = ts::ctx(&mut scn);
        let mut clk = clock::create_for_testing(ctx);
        clock::set_for_testing(&mut clk, 5_000_000);
        cp::request(&runner_cap, &mut reg, job_id, 2, 60_000, &clk);

        // Advance clock past deadline → mark timed out.
        clock::set_for_testing(&mut clk, 5_061_000);
        cp::mark_timed_out(&mut reg, job_id, 2, &clk);
        assert!(cp::is_timed_out(&reg, job_id, 2), 800);

        clock::destroy_for_testing(clk);
        ar::destroy_runner_cap_for_testing(runner_cap);
        ts::return_shared(reg);
        ts::end(scn);
    }

    #[test]
    fun seal_approve_buyer_iter_decrypt_after_advance() {
        let mut scn = ts::begin(SELLER);
        publish_default(&mut scn);
        hire_3_iters(&mut scn, 150_000);

        // Advance iter 1.
        ts::next_tx(&mut scn, RUNNER);
        let runner_cap = ar::mint_runner_cap_for_testing(ts::ctx(&mut scn));
        let mut j = ts::take_shared<LoopJob<SUI>>(&scn);
        let agent = ts::take_shared<Agent>(&scn);
        let ctx = ts::ctx(&mut scn);
        let clk = clock::create_for_testing(ctx);
        job::advance_iter_with_split<SUI>(
            &runner_cap, &mut j, &agent, 1, b"b", b"a",
            50_000, COMPUTE, PLATFORM, &clk, ctx,
        );
        clock::destroy_for_testing(clk);
        ar::destroy_runner_cap_for_testing(runner_cap);
        ts::return_shared(agent);
        ts::return_shared(j);

        // Buyer derives decryption capability for iter 1.
        ts::next_tx(&mut scn, BUYER);
        let j = ts::take_shared<LoopJob<SUI>>(&scn);
        let ctx = ts::ctx(&mut scn);
        job::seal_approve_buyer_iter_decrypt<SUI>(&j, 1, ctx);
        ts::return_shared(j);
        ts::end(scn);
    }
}
