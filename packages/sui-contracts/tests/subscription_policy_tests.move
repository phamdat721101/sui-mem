#[test_only]
module fhe_brain::subscription_policy_tests {
    use sui::test_scenario as ts;
    use sui::coin;
    use sui::sui::SUI;
    use sui::clock;
    use sui::transfer;
    use fhe_brain::subscription_policy::{
        Self as sp,
        SubscriptionPolicy,
        Subscription,
        EInsufficientPayment,
    };

    const ALICE: address = @0xA11CE;
    const BOB: address = @0xB0B;
    const PRICE: u64 = 100_000_000;       // 0.1 SUI
    const DURATION: u64 = 86_400_000;     // 1 day

    fun share_policy(scenario: &mut ts::Scenario) {
        ts::next_tx(scenario, ALICE);
        let policy = sp::create_policy(PRICE, DURATION, scenario.ctx());
        transfer::public_share_object(policy);
    }

    #[test]
    fun test_subscribe_happy_path() {
        let mut scenario = ts::begin(ALICE);
        share_policy(&mut scenario);

        ts::next_tx(&mut scenario, BOB);
        let policy = ts::take_shared<SubscriptionPolicy>(&scenario);
        let mut clk = clock::create_for_testing(scenario.ctx());
        clock::set_for_testing(&mut clk, 1_000_000);

        let payment = coin::mint_for_testing<SUI>(PRICE, scenario.ctx());
        let sub = sp::subscribe(&policy, payment, &clk, scenario.ctx());

        // Subscription belongs to BOB and is unexpired.
        assert!(sp::subscriber(&sub) == BOB, 0);
        assert!(sp::is_valid(&sub, &clk), 1);
        assert!(sp::expires_at(&sub) == 1_000_000 + DURATION, 2);

        // Advance past expiry → invalid.
        clock::increment_for_testing(&mut clk, DURATION + 1);
        assert!(!sp::is_valid(&sub, &clk), 3);

        transfer::public_transfer(sub, BOB);
        ts::return_shared(policy);
        clock::destroy_for_testing(clk);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = EInsufficientPayment)]
    fun test_subscribe_insufficient_payment_aborts() {
        let mut scenario = ts::begin(ALICE);
        share_policy(&mut scenario);

        ts::next_tx(&mut scenario, BOB);
        let policy = ts::take_shared<SubscriptionPolicy>(&scenario);
        let clk = clock::create_for_testing(scenario.ctx());

        // Pay 1 mist short of price.
        let payment = coin::mint_for_testing<SUI>(PRICE - 1, scenario.ctx());
        let sub = sp::subscribe(&policy, payment, &clk, scenario.ctx());

        // Cleanup paths so the test compiles in the abort case (unreachable).
        transfer::public_transfer(sub, BOB);
        ts::return_shared(policy);
        clock::destroy_for_testing(clk);
        ts::end(scenario);
    }
}
