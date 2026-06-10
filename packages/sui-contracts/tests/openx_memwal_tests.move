#[test_only]
module fhe_brain::openx_memwal_tests {
    use sui::test_scenario as ts;
    use sui::clock;
    use sui::coin;
    use sui::sui::SUI;
    use std::string;
    use fhe_brain::openx_memwal_marketplace::{Self as mp, MemWalBrain};
    use fhe_brain::openx_memwal_revenue_split::{Self as rs, CompositionPolicy};

    const SELLER: address = @0xA;
    const BUYER: address = @0xB;
    const OPERATOR: address = @0xC;
    const COAUTHOR: address = @0xD;

    /// Helper — fabricate a MemWalBrain in the current scenario tx.
    fun publish_test_brain(scn: &mut ts::Scenario) {
        let ctx = ts::ctx(scn);
        let mut clk = clock::create_for_testing(ctx);
        clock::set_for_testing(&mut clk, 1_000_000);
        mp::publish_brain(
            object::id_from_address(@0xACC),
            b"medical-research",
            b"Medical Research L3",
            b"Curated long-term medical knowledge",
            50_000, // $0.05
            false,
            1, // phala-tee
            b"https://example/sov",
            3, // L3
            &clk,
            ctx,
        );
        clock::destroy_for_testing(clk);
    }

    // ─── publish + lifecycle ─────────────────────────────────────────

    #[test]
    fun publish_then_unpublish() {
        let mut scn = ts::begin(SELLER);
        publish_test_brain(&mut scn);

        ts::next_tx(&mut scn, SELLER);
        let mut brain = ts::take_shared<MemWalBrain>(&scn);
        assert!(mp::is_active(&brain), 100);
        assert!(mp::price(&brain) == 50_000, 101);
        assert!(mp::cognitive_level(&brain) == 3, 102);

        let ctx = ts::ctx(&mut scn);
        let mut clk = clock::create_for_testing(ctx);
        mp::unpublish_brain(&mut brain, &clk, ctx);
        assert!(!mp::is_active(&brain), 103);
        clock::destroy_for_testing(clk);
        ts::return_shared(brain);
        ts::end(scn);
    }

    #[test]
    fun update_price_path() {
        let mut scn = ts::begin(SELLER);
        publish_test_brain(&mut scn);

        ts::next_tx(&mut scn, SELLER);
        let mut brain = ts::take_shared<MemWalBrain>(&scn);
        let ctx = ts::ctx(&mut scn);
        let clk = clock::create_for_testing(ctx);
        mp::update_price(&mut brain, 75_000, &clk, ctx);
        assert!(mp::price(&brain) == 75_000, 200);
        clock::destroy_for_testing(clk);
        ts::return_shared(brain);
        ts::end(scn);
    }

    #[test, expected_failure(abort_code = 0, location = mp)]
    fun non_seller_cannot_unpublish() {
        let mut scn = ts::begin(SELLER);
        publish_test_brain(&mut scn);
        ts::next_tx(&mut scn, BUYER);
        let mut brain = ts::take_shared<MemWalBrain>(&scn);
        let ctx = ts::ctx(&mut scn);
        let clk = clock::create_for_testing(ctx);
        mp::unpublish_brain(&mut brain, &clk, ctx); // should abort ENotSeller=0
        clock::destroy_for_testing(clk);
        ts::return_shared(brain);
        ts::end(scn);
    }

    #[test, expected_failure(abort_code = 4, location = mp)]
    fun seal_approve_query_rejects_stale_proof() {
        let mut scn = ts::begin(SELLER);
        publish_test_brain(&mut scn);
        ts::next_tx(&mut scn, BUYER);
        let brain = ts::take_shared<MemWalBrain>(&scn);
        let ctx = ts::ctx(&mut scn);
        let mut clk = clock::create_for_testing(ctx);
        // payment_proof_ts_ms = 1_000_000, advance clock 90s past it (>60s window).
        clock::set_for_testing(&mut clk, 1_090_000);
        mp::seal_approve_query(&brain, b"proof", 1_000_000, &clk); // EPaymentExpired = 4
        clock::destroy_for_testing(clk);
        ts::return_shared(brain);
        ts::end(scn);
    }

    #[test]
    fun seal_approve_query_within_window() {
        let mut scn = ts::begin(SELLER);
        publish_test_brain(&mut scn);
        ts::next_tx(&mut scn, BUYER);
        let brain = ts::take_shared<MemWalBrain>(&scn);
        let ctx = ts::ctx(&mut scn);
        let mut clk = clock::create_for_testing(ctx);
        clock::set_for_testing(&mut clk, 1_030_000); // 30s after proof
        mp::seal_approve_query(&brain, b"proof", 1_000_000, &clk);
        clock::destroy_for_testing(clk);
        ts::return_shared(brain);
        ts::end(scn);
    }

    // ─── revenue split ───────────────────────────────────────────────

    #[test]
    fun set_policy_and_distribute_two_authors() {
        let mut scn = ts::begin(SELLER);
        publish_test_brain(&mut scn);

        // Set 70/25/5 policy: seller 7000, coauthor 2500, operator floor 500.
        ts::next_tx(&mut scn, SELLER);
        let brain = ts::take_shared<MemWalBrain>(&scn);
        let ctx = ts::ctx(&mut scn);
        let authors = vector[
            rs::new_author_share(SELLER, 7000),
            rs::new_author_share(COAUTHOR, 2500),
        ];
        rs::set_policy_with_authors(&brain, authors, 500, ctx);
        ts::return_shared(brain);

        // Operator distributes a 1_000_000 micro-USDC payment.
        ts::next_tx(&mut scn, OPERATOR);
        let policy = ts::take_shared<CompositionPolicy>(&scn);
        let ctx = ts::ctx(&mut scn);
        let payment = coin::mint_for_testing<SUI>(1_000_000, ctx);
        rs::distribute(&policy, payment, 500, ctx);
        ts::return_shared(policy);
        ts::end(scn);
    }

    #[test, expected_failure(abort_code = 0, location = rs)]
    fun set_policy_rejects_bps_overflow() {
        let mut scn = ts::begin(SELLER);
        publish_test_brain(&mut scn);
        ts::next_tx(&mut scn, SELLER);
        let brain = ts::take_shared<MemWalBrain>(&scn);
        let ctx = ts::ctx(&mut scn);
        // 7000 + 2500 + 500 = 10_000 ✓; we use 6000 + 2500 + 500 = 9000 → fails
        let bad = vector[
            rs::new_author_share(SELLER, 6000),
            rs::new_author_share(COAUTHOR, 2500),
        ];
        rs::set_policy_with_authors(&brain, bad, 500, ctx); // EBpsOverflow = 0
        ts::return_shared(brain);
        ts::end(scn);
    }
}
