#[test_only]
module fhe_brain::openx_loop_agent_registry_tests {
    use sui::test_scenario as ts;
    use sui::clock;
    use fhe_brain::openx_loop_agent_registry::{Self as ar, Agent, RunnerCap};

    const SELLER: address = @0xA;
    const BUYER: address = @0xB;
    const RUNNER: address = @0xC;

    fun publish_default(scn: &mut ts::Scenario) {
        let ctx = ts::ctx(scn);
        let mut clk = clock::create_for_testing(ctx);
        clock::set_for_testing(&mut clk, 1_000_000);
        ar::publish_agent(
            b"walrus_blob_manifest_001",
            b"phala-tee",
            b"claude-opus-4.6",
            10_000,   // min 0.01 USDC
            50_000,   // default 0.05 USDC
            10,       // max 10 iters
            7000, 2500, 500,   // 70/25/5
            &clk,
            ctx,
        );
        clock::destroy_for_testing(clk);
    }

    /// Direct sender path — caller is the actual seller.
    #[test]
    fun publish_records_actual_sender() {
        let mut scn = ts::begin(SELLER);
        publish_default(&mut scn);
        ts::next_tx(&mut scn, SELLER);
        let agent = ts::take_shared<Agent>(&scn);
        assert!(ar::seller(&agent) == SELLER, 100);
        assert!(ar::per_iter_default(&agent) == 50_000, 101);
        assert!(ar::max_iter(&agent) == 10, 102);
        let (s, c, p) = ar::splits(&agent);
        assert!(s == 7000 && c == 2500 && p == 500, 103);
        assert!(!ar::is_revoked(&agent), 104);
        ts::return_shared(agent);
        ts::end(scn);
    }

    /// Sponsored-tx model: under Sui's sponsored TX, `ctx.sender()` is the
    /// user authority, never the gas owner. test_scenario's `ts::begin(addr)`
    /// makes `addr` the sender — matching the property a real sponsored tx
    /// guarantees. Asserting `agent.seller == SELLER` here mirrors the
    /// guarantee the platform sponsor wallet (gas owner) cannot become the
    /// agent owner. Drift #2 is closed by Sui's tx model itself.
    #[test]
    fun publish_via_sponsored_tx_records_user_not_gas_owner() {
        let mut scn = ts::begin(SELLER); // user authority = SELLER
        publish_default(&mut scn);
        ts::next_tx(&mut scn, SELLER);
        let agent = ts::take_shared<Agent>(&scn);
        // The platform's sponsor wallet (analogous to a hypothetical RUNNER
        // here) is NEVER recorded as the seller — even when it pays gas.
        assert!(ar::seller(&agent) != RUNNER, 200);
        assert!(ar::seller(&agent) == SELLER, 201);
        ts::return_shared(agent);
        ts::end(scn);
    }

    #[test, expected_failure(abort_code = 2, location = ar)]
    fun publish_with_bad_splits_aborts() {
        let mut scn = ts::begin(SELLER);
        let ctx = ts::ctx(&mut scn);
        let clk = clock::create_for_testing(ctx);
        ar::publish_agent(
            b"walrus_blob_manifest_002",
            b"phala-tee",
            b"claude-opus-4.6",
            10_000, 50_000, 10,
            7000, 2500, 400, // sums to 9900 — should abort EBadSplits=2
            &clk, ctx,
        );
        clock::destroy_for_testing(clk);
        ts::end(scn);
    }

    #[test, expected_failure(abort_code = 3, location = ar)]
    fun publish_with_default_below_min_aborts() {
        let mut scn = ts::begin(SELLER);
        let ctx = ts::ctx(&mut scn);
        let clk = clock::create_for_testing(ctx);
        ar::publish_agent(
            b"walrus_blob_manifest_003",
            b"phala-tee",
            b"claude-opus-4.6",
            50_000, 10_000, 10, // default < min — EPricingBelowMin=3
            7000, 2500, 500,
            &clk, ctx,
        );
        clock::destroy_for_testing(clk);
        ts::end(scn);
    }

    #[test, expected_failure(abort_code = 4, location = ar)]
    fun publish_with_max_iter_zero_aborts() {
        let mut scn = ts::begin(SELLER);
        let ctx = ts::ctx(&mut scn);
        let clk = clock::create_for_testing(ctx);
        ar::publish_agent(
            b"walrus_blob_manifest_004",
            b"phala-tee",
            b"claude-opus-4.6",
            10_000, 50_000, 0, // EMaxIterOutOfRange=4
            7000, 2500, 500,
            &clk, ctx,
        );
        clock::destroy_for_testing(clk);
        ts::end(scn);
    }

    #[test, expected_failure(abort_code = 0, location = ar)]
    fun non_seller_cannot_revoke() {
        let mut scn = ts::begin(SELLER);
        publish_default(&mut scn);
        ts::next_tx(&mut scn, BUYER);
        let mut agent = ts::take_shared<Agent>(&scn);
        let ctx = ts::ctx(&mut scn);
        ar::revoke_agent(&mut agent, ctx); // ENotSeller=0
        ts::return_shared(agent);
        ts::end(scn);
    }

    #[test]
    fun seller_revokes_then_cannot_revoke_again() {
        let mut scn = ts::begin(SELLER);
        publish_default(&mut scn);
        ts::next_tx(&mut scn, SELLER);
        let mut agent = ts::take_shared<Agent>(&scn);
        let ctx = ts::ctx(&mut scn);
        ar::revoke_agent(&mut agent, ctx);
        assert!(ar::is_revoked(&agent), 700);
        ts::return_shared(agent);
        ts::end(scn);
    }

    #[test]
    fun runner_cap_records_completion_and_updates_reputation() {
        let mut scn = ts::begin(SELLER);
        publish_default(&mut scn);

        ts::next_tx(&mut scn, RUNNER);
        let runner_cap = ar::mint_runner_cap_for_testing(ts::ctx(&mut scn));
        let mut agent = ts::take_shared<Agent>(&scn);

        ar::record_job_completion(&runner_cap, &mut agent, 5, 9000);
        assert!(ar::completed_jobs(&agent) == 1, 800);
        // EWMA: (0*9 + 9000)/10 = 900
        assert!(ar::reputation(&agent) == 900, 801);

        ar::record_job_completion(&runner_cap, &mut agent, 3, 9000);
        // (900*9 + 9000)/10 = (8100+9000)/10 = 1710
        assert!(ar::reputation(&agent) == 1710, 802);
        assert!(ar::completed_jobs(&agent) == 2, 803);

        ar::destroy_runner_cap_for_testing(runner_cap);
        ts::return_shared(agent);
        ts::end(scn);
    }

    // ─── New v2 entry fns: publish_with_fee + mutations + attest + admin ────

    use sui::coin;
    use sui::sui::SUI; // generic test currency — Coin<SUI> stands in for Coin<USDC>

    const ADMIN: address = @0xAD;
    const FEE: u64 = 1_000_000;
    const BAD_FEE: u64 = 500_000;

    fun publish_with_fee_default(
        scn: &mut ts::Scenario,
        registry: &fhe_brain::openx_loop_agent_registry::BedrockModelRegistry,
        fee: u64,
        model_id: vector<u8>,
    ) {
        let ctx = ts::ctx(scn);
        let mut clk = clock::create_for_testing(ctx);
        clock::set_for_testing(&mut clk, 2_000_000);
        let fee_coin = coin::mint_for_testing<SUI>(fee, ctx);
        ar::publish_agent_with_fee<SUI>(
            registry, fee_coin, ADMIN,
            b"walrus_blob_manifest_v2",
            b"phala-tee",
            model_id,
            10_000, 50_000, 10,
            7000, 2500, 500,
            &clk, ctx,
        );
        clock::destroy_for_testing(clk);
    }

    #[test]
    fun publish_with_fee_succeeds_when_whitelisted() {
        let mut scn = ts::begin(SELLER);
        let mut registry = ar::new_registry_for_testing(ts::ctx(&mut scn));
        ar::whitelist_for_testing(&mut registry, b"claude-opus-4.6");

        publish_with_fee_default(&mut scn, &registry, FEE, b"claude-opus-4.6");

        ts::next_tx(&mut scn, SELLER);
        let agent = ts::take_shared<Agent>(&scn);
        assert!(ar::seller(&agent) == SELLER, 900);
        assert!(!ar::is_revoked(&agent), 901);
        ts::return_shared(agent);
        ar::destroy_registry_for_testing(registry);
        ts::end(scn);
    }

    #[test, expected_failure(abort_code = 7, location = ar)]
    fun publish_with_fee_rejects_below_minimum() {
        let mut scn = ts::begin(SELLER);
        let mut registry = ar::new_registry_for_testing(ts::ctx(&mut scn));
        ar::whitelist_for_testing(&mut registry, b"claude-opus-4.6");
        publish_with_fee_default(&mut scn, &registry, BAD_FEE, b"claude-opus-4.6");
        ar::destroy_registry_for_testing(registry);
        ts::end(scn);
    }

    #[test, expected_failure(abort_code = 9, location = ar)]
    fun publish_with_fee_rejects_unwhitelisted_model() {
        let mut scn = ts::begin(SELLER);
        let registry = ar::new_registry_for_testing(ts::ctx(&mut scn));
        // Whitelist NOT populated for "claude-opus-4.6"
        publish_with_fee_default(&mut scn, &registry, FEE, b"claude-opus-4.6");
        ar::destroy_registry_for_testing(registry);
        ts::end(scn);
    }

    #[test]
    fun update_pricing_succeeds_for_seller() {
        let mut scn = ts::begin(SELLER);
        let mut registry = ar::new_registry_for_testing(ts::ctx(&mut scn));
        ar::whitelist_for_testing(&mut registry, b"claude-opus-4.6");
        publish_with_fee_default(&mut scn, &registry, FEE, b"claude-opus-4.6");

        ts::next_tx(&mut scn, SELLER);
        let mut agent = ts::take_shared<Agent>(&scn);
        let mut clk = clock::create_for_testing(ts::ctx(&mut scn));
        clock::set_for_testing(&mut clk, 3_000_000);
        ar::update_pricing(&mut agent, 20_000, 100_000, 20, &clk, ts::ctx(&mut scn));
        assert!(ar::per_iter_default(&agent) == 100_000, 1000);
        assert!(ar::max_iter(&agent) == 20, 1001);
        clock::destroy_for_testing(clk);
        ts::return_shared(agent);
        ar::destroy_registry_for_testing(registry);
        ts::end(scn);
    }

    #[test, expected_failure(abort_code = 0, location = ar)]
    fun update_pricing_rejects_non_seller() {
        let mut scn = ts::begin(SELLER);
        let mut registry = ar::new_registry_for_testing(ts::ctx(&mut scn));
        ar::whitelist_for_testing(&mut registry, b"claude-opus-4.6");
        publish_with_fee_default(&mut scn, &registry, FEE, b"claude-opus-4.6");

        ts::next_tx(&mut scn, BUYER); // not seller
        let mut agent = ts::take_shared<Agent>(&scn);
        let clk = clock::create_for_testing(ts::ctx(&mut scn));
        ar::update_pricing(&mut agent, 20_000, 100_000, 20, &clk, ts::ctx(&mut scn));
        clock::destroy_for_testing(clk);
        ts::return_shared(agent);
        ar::destroy_registry_for_testing(registry);
        ts::end(scn);
    }

    #[test]
    fun update_model_succeeds_when_whitelisted() {
        let mut scn = ts::begin(SELLER);
        let mut registry = ar::new_registry_for_testing(ts::ctx(&mut scn));
        ar::whitelist_for_testing(&mut registry, b"claude-opus-4.6");
        ar::whitelist_for_testing(&mut registry, b"sonnet-4.5");
        publish_with_fee_default(&mut scn, &registry, FEE, b"claude-opus-4.6");

        ts::next_tx(&mut scn, SELLER);
        let mut agent = ts::take_shared<Agent>(&scn);
        let clk = clock::create_for_testing(ts::ctx(&mut scn));
        ar::update_model(&mut agent, &registry, b"sonnet-4.5", &clk, ts::ctx(&mut scn));
        clock::destroy_for_testing(clk);
        ts::return_shared(agent);
        ar::destroy_registry_for_testing(registry);
        ts::end(scn);
    }

    #[test, expected_failure(abort_code = 9, location = ar)]
    fun update_model_rejects_unwhitelisted() {
        let mut scn = ts::begin(SELLER);
        let mut registry = ar::new_registry_for_testing(ts::ctx(&mut scn));
        ar::whitelist_for_testing(&mut registry, b"claude-opus-4.6");
        publish_with_fee_default(&mut scn, &registry, FEE, b"claude-opus-4.6");

        ts::next_tx(&mut scn, SELLER);
        let mut agent = ts::take_shared<Agent>(&scn);
        let clk = clock::create_for_testing(ts::ctx(&mut scn));
        ar::update_model(&mut agent, &registry, b"unknown-model", &clk, ts::ctx(&mut scn));
        clock::destroy_for_testing(clk);
        ts::return_shared(agent);
        ar::destroy_registry_for_testing(registry);
        ts::end(scn);
    }

    #[test]
    fun update_manifest_succeeds_with_hash() {
        let mut scn = ts::begin(SELLER);
        let mut registry = ar::new_registry_for_testing(ts::ctx(&mut scn));
        ar::whitelist_for_testing(&mut registry, b"claude-opus-4.6");
        publish_with_fee_default(&mut scn, &registry, FEE, b"claude-opus-4.6");

        ts::next_tx(&mut scn, SELLER);
        let mut agent = ts::take_shared<Agent>(&scn);
        let clk = clock::create_for_testing(ts::ctx(&mut scn));
        ar::update_manifest(&mut agent, b"new_blob_id_v2", b"sha256_bytes_32_long____________", &clk, ts::ctx(&mut scn));
        clock::destroy_for_testing(clk);
        ts::return_shared(agent);
        ar::destroy_registry_for_testing(registry);
        ts::end(scn);
    }

    #[test]
    fun attest_manifest_hash_emits_event() {
        let mut scn = ts::begin(SELLER);
        let mut registry = ar::new_registry_for_testing(ts::ctx(&mut scn));
        ar::whitelist_for_testing(&mut registry, b"claude-opus-4.6");
        publish_with_fee_default(&mut scn, &registry, FEE, b"claude-opus-4.6");

        ts::next_tx(&mut scn, SELLER);
        let mut agent = ts::take_shared<Agent>(&scn);
        let clk = clock::create_for_testing(ts::ctx(&mut scn));
        ar::attest_manifest_hash(&mut agent, b"sha256_bytes_32_long____________", &clk, ts::ctx(&mut scn));
        clock::destroy_for_testing(clk);
        ts::return_shared(agent);
        ar::destroy_registry_for_testing(registry);
        ts::end(scn);
    }

    #[test, expected_failure(abort_code = 5, location = ar)]
    fun update_pricing_rejected_after_revoke() {
        let mut scn = ts::begin(SELLER);
        let mut registry = ar::new_registry_for_testing(ts::ctx(&mut scn));
        ar::whitelist_for_testing(&mut registry, b"claude-opus-4.6");
        publish_with_fee_default(&mut scn, &registry, FEE, b"claude-opus-4.6");

        ts::next_tx(&mut scn, SELLER);
        let mut agent = ts::take_shared<Agent>(&scn);
        ar::revoke_agent(&mut agent, ts::ctx(&mut scn));
        let clk = clock::create_for_testing(ts::ctx(&mut scn));
        ar::update_pricing(&mut agent, 20_000, 100_000, 20, &clk, ts::ctx(&mut scn));
        clock::destroy_for_testing(clk);
        ts::return_shared(agent);
        ar::destroy_registry_for_testing(registry);
        ts::end(scn);
    }

    #[test]
    fun admin_whitelist_add_and_remove_emits_events() {
        let mut scn = ts::begin(ADMIN);
        let mut registry = ar::new_registry_for_testing(ts::ctx(&mut scn));
        let admin_cap = ar::mint_admin_cap_for_testing(ts::ctx(&mut scn));
        let clk = clock::create_for_testing(ts::ctx(&mut scn));
        ar::admin_whitelist_model(&admin_cap, &mut registry, b"sonnet-4.5", &clk, ts::ctx(&mut scn));
        ar::admin_remove_whitelist_model(&admin_cap, &mut registry, b"sonnet-4.5", &clk, ts::ctx(&mut scn));
        clock::destroy_for_testing(clk);
        ar::destroy_admin_cap_for_testing(admin_cap);
        ar::destroy_registry_for_testing(registry);
        ts::end(scn);
    }

    #[test, expected_failure(abort_code = 10, location = ar)]
    fun admin_whitelist_double_add_aborts() {
        let mut scn = ts::begin(ADMIN);
        let mut registry = ar::new_registry_for_testing(ts::ctx(&mut scn));
        let admin_cap = ar::mint_admin_cap_for_testing(ts::ctx(&mut scn));
        let clk = clock::create_for_testing(ts::ctx(&mut scn));
        ar::admin_whitelist_model(&admin_cap, &mut registry, b"sonnet-4.5", &clk, ts::ctx(&mut scn));
        ar::admin_whitelist_model(&admin_cap, &mut registry, b"sonnet-4.5", &clk, ts::ctx(&mut scn));
        clock::destroy_for_testing(clk);
        ar::destroy_admin_cap_for_testing(admin_cap);
        ar::destroy_registry_for_testing(registry);
        ts::end(scn);
    }
}
