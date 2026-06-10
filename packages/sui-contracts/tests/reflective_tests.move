#[test_only]
module fhe_brain::reflective_tests {
    use sui::test_scenario as ts;
    use sui::coin;
    use sui::sui::SUI;
    use sui::clock::{Self, Clock};
    use sui::transfer;
    use fhe_brain::reflective::{
        Self as r,
        ReflectiveTrace,
        License,
        ENotOwner,
        EAlreadyPublished,
        EBadSubscription,
    };
    use fhe_brain::subscription_policy::{Self as sp, SubscriptionPolicy};

    const ALICE: address = @0xA11CE;
    const BOB: address = @0xB0B;
    const PRICE: u64 = 5_000_000_000; // 5 SUI in MIST — license tier
    const LICENSE_DURATION_MS: u64 = 7 * 24 * 60 * 60 * 1000; // 7 days

    fun setup(scenario: &mut ts::Scenario, fake_workflow_id: ID): (ID, ID) {
        ts::next_tx(scenario, ALICE);
        let policy = sp::create_policy(PRICE, LICENSE_DURATION_MS, scenario.ctx());
        let policy_id = object::id(&policy);
        transfer::public_share_object(policy);
        ts::next_tx(scenario, ALICE);
        let trace = r::create_trace(
            b"reflect-mkt-7step-r5",
            fake_workflow_id,
            b"walrus:rules-blob",
            policy_id,
            5_000,
            5,
            scenario.ctx(),
        );
        let t_id = object::id(&trace);
        transfer::public_transfer(trace, ALICE);
        (policy_id, t_id)
    }

    #[test]
    fun test_create_publish_emits() {
        let mut scenario = ts::begin(ALICE);
        let fake_wf = object::id_from_address(@0xDEAD);
        let (_p, _t) = setup(&mut scenario, fake_wf);
        ts::next_tx(&mut scenario, ALICE);
        let mut trace = ts::take_from_sender<ReflectiveTrace>(&scenario);
        r::publish_trace(&mut trace, scenario.ctx());
        assert!(r::is_published(&trace), 0);
        assert!(r::licenses_sold(&trace) == 0, 1);
        ts::return_to_sender(&scenario, trace);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = ENotOwner)]
    fun test_publish_non_owner_aborts() {
        let mut scenario = ts::begin(ALICE);
        let fake_wf = object::id_from_address(@0xDEAD);
        let (_p, _t) = setup(&mut scenario, fake_wf);
        ts::next_tx(&mut scenario, ALICE);
        let mut trace = ts::take_from_address<ReflectiveTrace>(&scenario, ALICE);
        ts::next_tx(&mut scenario, BOB);
        r::publish_trace(&mut trace, scenario.ctx());
        ts::return_to_address(ALICE, trace);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = EAlreadyPublished)]
    fun test_double_publish_aborts() {
        let mut scenario = ts::begin(ALICE);
        let fake_wf = object::id_from_address(@0xDEAD);
        let (_p, _t) = setup(&mut scenario, fake_wf);
        ts::next_tx(&mut scenario, ALICE);
        let mut trace = ts::take_from_sender<ReflectiveTrace>(&scenario);
        r::publish_trace(&mut trace, scenario.ctx());
        r::publish_trace(&mut trace, scenario.ctx());
        ts::return_to_sender(&scenario, trace);
        ts::end(scenario);
    }

    #[test]
    fun test_mint_license_and_seal_approve() {
        let mut scenario = ts::begin(ALICE);
        let fake_wf = object::id_from_address(@0xDEAD);
        let (_p_id, t_id) = setup(&mut scenario, fake_wf);
        ts::next_tx(&mut scenario, ALICE);
        let mut trace = ts::take_from_sender<ReflectiveTrace>(&scenario);
        r::publish_trace(&mut trace, scenario.ctx());

        // BOB pays the license fee.
        ts::next_tx(&mut scenario, BOB);
        let policy = ts::take_shared<SubscriptionPolicy>(&scenario);
        let clk = clock::create_for_testing(scenario.ctx());
        let payment = coin::mint_for_testing<SUI>(PRICE, scenario.ctx());
        let sub = sp::subscribe(&policy, payment, &clk, scenario.ctx());

        // SEAL approver runs dry — must not abort.
        r::seal_approve_license_unlock(
            object::id_to_bytes(&t_id),
            &trace,
            &policy,
            &sub,
            &clk,
        );

        // Mint license.
        let license = r::mint_license(&mut trace, &sub, &clk, scenario.ctx());
        assert!(r::licenses_sold(&trace) == 1, 0);
        assert!(r::license_licensee(&license) == BOB, 1);
        transfer::public_transfer(license, BOB);

        transfer::public_transfer(sub, BOB);
        clock::destroy_for_testing(clk);
        ts::return_shared(policy);
        ts::return_to_address(ALICE, trace);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = EBadSubscription)]
    fun test_seal_approve_wrong_id_aborts() {
        let mut scenario = ts::begin(ALICE);
        let fake_wf = object::id_from_address(@0xDEAD);
        let (_p_id, _t_id) = setup(&mut scenario, fake_wf);
        ts::next_tx(&mut scenario, ALICE);
        let mut trace = ts::take_from_sender<ReflectiveTrace>(&scenario);
        r::publish_trace(&mut trace, scenario.ctx());
        ts::next_tx(&mut scenario, BOB);
        let policy = ts::take_shared<SubscriptionPolicy>(&scenario);
        let clk = clock::create_for_testing(scenario.ctx());
        let payment = coin::mint_for_testing<SUI>(PRICE, scenario.ctx());
        let sub = sp::subscribe(&policy, payment, &clk, scenario.ctx());
        r::seal_approve_license_unlock(
            b"not-the-trace-id",
            &trace,
            &policy,
            &sub,
            &clk,
        );
        transfer::public_transfer(sub, BOB);
        clock::destroy_for_testing(clk);
        ts::return_shared(policy);
        ts::return_to_address(ALICE, trace);
        ts::end(scenario);
    }
}
