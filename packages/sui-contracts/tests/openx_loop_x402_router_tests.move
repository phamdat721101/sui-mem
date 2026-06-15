#[test_only]
module fhe_brain::openx_loop_x402_router_tests {
    use sui::test_scenario as ts;
    use sui::clock;
    use sui::coin;
    use sui::sui::SUI;
    use fhe_brain::openx_loop_agent_registry::{Self as ar, Agent};
    use fhe_brain::openx_loop_x402_router::{Self as r, X402RouterConfig};

    const SELLER: address = @0xA;
    const BUYER: address = @0xB;
    const COMPUTE: address = @0xC1;
    const PLATFORM: address = @0xC2;

    fun publish_default(scn: &mut ts::Scenario) {
        let ctx = ts::ctx(scn);
        let mut clk = clock::create_for_testing(ctx);
        clock::set_for_testing(&mut clk, 1_000_000);
        ar::publish_agent(
            b"manifest_blob_x402",
            b"phala-tee", b"claude-opus-4.6",
            10_000, 50_000, 10,
            7000, 2500, 500,
            &clk, ctx,
        );
        clock::destroy_for_testing(clk);
    }

    fun share_config(scn: &mut ts::Scenario) {
        let ctx = ts::ctx(scn);
        let cfg = r::create_config_for_testing(COMPUTE, PLATFORM, 1_000, ctx);
        r::share_config_for_testing(cfg);
    }

    /// 100µ at 70/25/5 → 70/25/5 exact (no rounding).
    #[test]
    fun settle_distributes_70_25_5_exact() {
        let mut scn = ts::begin(SELLER);
        publish_default(&mut scn);
        ts::next_tx(&mut scn, SELLER);
        share_config(&mut scn);

        ts::next_tx(&mut scn, BUYER);
        let agent = ts::take_shared<Agent>(&scn);
        let cfg = ts::take_shared<X402RouterConfig>(&scn);
        let ctx = ts::ctx(&mut scn);
        let mut clk = clock::create_for_testing(ctx);
        clock::set_for_testing(&mut clk, 2_000_000);
        let payment = coin::mint_for_testing<SUI>(100_000, ctx); // 100µ × 1000 = 100k
        r::settle_and_distribute<SUI>(&cfg, &agent, payment, BUYER, &clk, ctx);

        clock::destroy_for_testing(clk);
        ts::return_shared(agent);
        ts::return_shared(cfg);

        // After the tx, SELLER should have 70_000, COMPUTE 25_000, PLATFORM 5_000.
        ts::next_tx(&mut scn, SELLER);
        {
            let c = ts::take_from_address<coin::Coin<SUI>>(&scn, SELLER);
            assert!(coin::value(&c) == 70_000, 100);
            ts::return_to_address(SELLER, c);
        };
        {
            let c = ts::take_from_address<coin::Coin<SUI>>(&scn, COMPUTE);
            assert!(coin::value(&c) == 25_000, 101);
            ts::return_to_address(COMPUTE, c);
        };
        {
            let c = ts::take_from_address<coin::Coin<SUI>>(&scn, PLATFORM);
            assert!(coin::value(&c) == 5_000, 102);
            ts::return_to_address(PLATFORM, c);
        };
        ts::end(scn);
    }

    /// 50_001µ at 70/25/5 → 35_000 / 12_500 / 2_501 (platform absorbs +1 dust).
    #[test]
    fun settle_rounding_remainder_to_platform() {
        let mut scn = ts::begin(SELLER);
        publish_default(&mut scn);
        ts::next_tx(&mut scn, SELLER);
        share_config(&mut scn);

        ts::next_tx(&mut scn, BUYER);
        let agent = ts::take_shared<Agent>(&scn);
        let cfg = ts::take_shared<X402RouterConfig>(&scn);
        let ctx = ts::ctx(&mut scn);
        let mut clk = clock::create_for_testing(ctx);
        clock::set_for_testing(&mut clk, 2_000_000);
        let payment = coin::mint_for_testing<SUI>(50_001, ctx);
        r::settle_and_distribute<SUI>(&cfg, &agent, payment, BUYER, &clk, ctx);

        clock::destroy_for_testing(clk);
        ts::return_shared(agent);
        ts::return_shared(cfg);

        ts::next_tx(&mut scn, SELLER);
        {
            let c = ts::take_from_address<coin::Coin<SUI>>(&scn, SELLER);
            assert!(coin::value(&c) == 35_000, 200); // 50_001 * 7000 / 10000 = 35_000
            ts::return_to_address(SELLER, c);
        };
        {
            let c = ts::take_from_address<coin::Coin<SUI>>(&scn, COMPUTE);
            assert!(coin::value(&c) == 12_500, 201); // 50_001 * 2500 / 10000 = 12_500
            ts::return_to_address(COMPUTE, c);
        };
        {
            let c = ts::take_from_address<coin::Coin<SUI>>(&scn, PLATFORM);
            assert!(coin::value(&c) == 2_501, 202);  // 50_001 - 35_000 - 12_500
            ts::return_to_address(PLATFORM, c);
        };
        ts::end(scn);
    }

    #[test, expected_failure(abort_code = 5, location = ar)]
    fun revoked_agent_rejects_settle() {
        let mut scn = ts::begin(SELLER);
        publish_default(&mut scn);
        ts::next_tx(&mut scn, SELLER);
        share_config(&mut scn);

        // Seller revokes.
        ts::next_tx(&mut scn, SELLER);
        let mut agent = ts::take_shared<Agent>(&scn);
        ar::revoke_agent(&mut agent, ts::ctx(&mut scn));
        ts::return_shared(agent);

        // Buyer tries to pay → assert_not_revoked aborts ERevoked=5 in agent_registry.
        ts::next_tx(&mut scn, BUYER);
        let agent = ts::take_shared<Agent>(&scn);
        let cfg = ts::take_shared<X402RouterConfig>(&scn);
        let ctx = ts::ctx(&mut scn);
        let clk = clock::create_for_testing(ctx);
        let payment = coin::mint_for_testing<SUI>(50_000, ctx);
        r::settle_and_distribute<SUI>(&cfg, &agent, payment, BUYER, &clk, ctx);
        clock::destroy_for_testing(clk);
        ts::return_shared(agent);
        ts::return_shared(cfg);
        ts::end(scn);
    }

    #[test, expected_failure(abort_code = 1, location = r)]
    fun settle_below_min_aborts() {
        let mut scn = ts::begin(SELLER);
        publish_default(&mut scn);
        ts::next_tx(&mut scn, SELLER);
        share_config(&mut scn);

        ts::next_tx(&mut scn, BUYER);
        let agent = ts::take_shared<Agent>(&scn);
        let cfg = ts::take_shared<X402RouterConfig>(&scn);
        let ctx = ts::ctx(&mut scn);
        let clk = clock::create_for_testing(ctx);
        // agent.per_iter_min = 10_000 > cfg.min = 1_000 → floor = 10_000; pay 5_000 fails.
        let payment = coin::mint_for_testing<SUI>(5_000, ctx);
        r::settle_and_distribute<SUI>(&cfg, &agent, payment, BUYER, &clk, ctx);
        clock::destroy_for_testing(clk);
        ts::return_shared(agent);
        ts::return_shared(cfg);
        ts::end(scn);
    }

    #[test]
    fun seal_approve_runner_decrypt_within_window() {
        let mut scn = ts::begin(SELLER);
        publish_default(&mut scn);
        ts::next_tx(&mut scn, BUYER);
        let agent = ts::take_shared<Agent>(&scn);
        let ctx = ts::ctx(&mut scn);
        let mut clk = clock::create_for_testing(ctx);
        clock::set_for_testing(&mut clk, 1_030_000); // 30s after proof
        r::seal_approve_runner_decrypt(&agent, b"proof", 1_000_000, &clk);
        clock::destroy_for_testing(clk);
        ts::return_shared(agent);
        ts::end(scn);
    }

    #[test, expected_failure(abort_code = 2, location = r)]
    fun seal_approve_runner_decrypt_stale_aborts() {
        let mut scn = ts::begin(SELLER);
        publish_default(&mut scn);
        ts::next_tx(&mut scn, BUYER);
        let agent = ts::take_shared<Agent>(&scn);
        let ctx = ts::ctx(&mut scn);
        let mut clk = clock::create_for_testing(ctx);
        clock::set_for_testing(&mut clk, 1_090_000); // 90s after proof — stale.
        r::seal_approve_runner_decrypt(&agent, b"proof", 1_000_000, &clk);
        clock::destroy_for_testing(clk);
        ts::return_shared(agent);
        ts::end(scn);
    }

    #[test]
    fun seal_approve_buyer_decrypt_only_buyer() {
        let mut scn = ts::begin(BUYER);
        let ctx = ts::ctx(&mut scn);
        r::seal_approve_buyer_decrypt(BUYER, ctx);
        ts::end(scn);
    }

    #[test, expected_failure(abort_code = 3, location = r)]
    fun seal_approve_buyer_decrypt_other_aborts() {
        let mut scn = ts::begin(SELLER);
        let ctx = ts::ctx(&mut scn);
        r::seal_approve_buyer_decrypt(BUYER, ctx); // sender=SELLER, expected=BUYER
        ts::end(scn);
    }
}
