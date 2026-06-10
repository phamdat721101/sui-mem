#[test_only]
module fhe_brain::skill_tests {
    use sui::test_scenario as ts;
    use sui::coin;
    use sui::sui::SUI;
    use sui::clock::{Self, Clock};
    use sui::transfer;
    use std::option;
    use fhe_brain::skill::{
        Self as sk,
        Skill,
        ENotOwner,
        EAlreadyPublished,
        EBadSubscription,
        EPaymentExpired,
    };
    use fhe_brain::subscription_policy::{Self as sp, SubscriptionPolicy};

    const ALICE: address = @0xA11CE;
    const BOB: address = @0xB0B;
    const PRICE: u64 = 50_000_000;
    const PER_CALL_DURATION: u64 = 30_000;

    fun setup(scenario: &mut ts::Scenario): (ID, ID) {
        ts::next_tx(scenario, ALICE);
        let policy = sp::create_policy(PRICE, PER_CALL_DURATION, scenario.ctx());
        let policy_id = object::id(&policy);
        transfer::public_share_object(policy);
        ts::next_tx(scenario, ALICE);
        let s = sk::create_skill(
            b"ingest-url",
            b"walrus:skill-manifest",
            policy_id,
            50,
            false,
            0,
            scenario.ctx(),
        );
        let s_id = object::id(&s);
        transfer::public_transfer(s, ALICE);
        (policy_id, s_id)
    }

    #[test]
    fun test_create_publish_invoke() {
        let mut scenario = ts::begin(ALICE);
        let (_p, _s) = setup(&mut scenario);
        ts::next_tx(&mut scenario, ALICE);
        let mut skill = ts::take_from_sender<Skill>(&scenario);
        sk::publish_skill(&mut skill, scenario.ctx());
        assert!(sk::is_published(&skill), 0);
        sk::register_invocation(&mut skill, scenario.ctx());
        sk::register_invocation(&mut skill, scenario.ctx());
        assert!(sk::invocations(&skill) == 2, 1);
        ts::return_to_sender(&scenario, skill);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = ENotOwner)]
    fun test_publish_non_owner_aborts() {
        let mut scenario = ts::begin(ALICE);
        let (_p, _s) = setup(&mut scenario);
        ts::next_tx(&mut scenario, ALICE);
        let mut skill = ts::take_from_address<Skill>(&scenario, ALICE);
        ts::next_tx(&mut scenario, BOB);
        sk::publish_skill(&mut skill, scenario.ctx());
        ts::return_to_address(ALICE, skill);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = EAlreadyPublished)]
    fun test_double_publish_aborts() {
        let mut scenario = ts::begin(ALICE);
        let (_p, _s) = setup(&mut scenario);
        ts::next_tx(&mut scenario, ALICE);
        let mut skill = ts::take_from_sender<Skill>(&scenario);
        sk::publish_skill(&mut skill, scenario.ctx());
        sk::publish_skill(&mut skill, scenario.ctx());
        ts::return_to_sender(&scenario, skill);
        ts::end(scenario);
    }

    #[test]
    fun test_seal_approve_skill_call_happy_path() {
        let mut scenario = ts::begin(ALICE);
        let (_p_id, s_id) = setup(&mut scenario);
        ts::next_tx(&mut scenario, ALICE);
        let mut skill = ts::take_from_sender<Skill>(&scenario);
        sk::publish_skill(&mut skill, scenario.ctx());
        ts::next_tx(&mut scenario, BOB);
        let policy = ts::take_shared<SubscriptionPolicy>(&scenario);
        let clk = clock::create_for_testing(scenario.ctx());
        let payment = coin::mint_for_testing<SUI>(PRICE, scenario.ctx());
        let sub = sp::subscribe(&policy, payment, &clk, scenario.ctx());
        sk::seal_approve_skill_call(
            object::id_to_bytes(&s_id),
            &skill,
            &policy,
            &sub,
            &clk,
            option::none(),
        );
        transfer::public_transfer(sub, BOB);
        clock::destroy_for_testing(clk);
        ts::return_shared(policy);
        ts::return_to_address(ALICE, skill);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = EBadSubscription)]
    fun test_seal_approve_wrong_id_aborts() {
        let mut scenario = ts::begin(ALICE);
        let (_p_id, _s_id) = setup(&mut scenario);
        ts::next_tx(&mut scenario, ALICE);
        let mut skill = ts::take_from_sender<Skill>(&scenario);
        sk::publish_skill(&mut skill, scenario.ctx());
        ts::next_tx(&mut scenario, BOB);
        let policy = ts::take_shared<SubscriptionPolicy>(&scenario);
        let clk = clock::create_for_testing(scenario.ctx());
        let payment = coin::mint_for_testing<SUI>(PRICE, scenario.ctx());
        let sub = sp::subscribe(&policy, payment, &clk, scenario.ctx());
        sk::seal_approve_skill_call(
            b"not-the-skill-id",
            &skill,
            &policy,
            &sub,
            &clk,
            option::none(),
        );
        transfer::public_transfer(sub, BOB);
        clock::destroy_for_testing(clk);
        ts::return_shared(policy);
        ts::return_to_address(ALICE, skill);
        ts::end(scenario);
    }
}
