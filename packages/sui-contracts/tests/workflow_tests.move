#[test_only]
module fhe_brain::workflow_tests {
    use sui::test_scenario as ts;
    use sui::coin;
    use sui::sui::SUI;
    use sui::clock::{Self, Clock};
    use sui::transfer;
    use std::option;
    use fhe_brain::workflow::{
        Self as wf,
        Workflow,
        ENotOwner,
        EAlreadyPublished,
        ENotPublished,
        EBadSubscription,
        EKYARequired,
        EPaymentExpired,
    };
    use fhe_brain::subscription_policy::{Self as sp, SubscriptionPolicy};

    const ALICE: address = @0xA11CE;
    const BOB: address = @0xB0B;
    const PRICE: u64 = 100_000_000;          // 0.1 SUI in MIST
    const PER_CALL_DURATION: u64 = 30_000;   // 30 sec — well under 60s window

    fun setup(scenario: &mut ts::Scenario, kya_required: bool): (ID, ID) {
        ts::next_tx(scenario, ALICE);
        // Per-call policy: short window so the 60s check passes.
        let policy = sp::create_policy(PRICE, PER_CALL_DURATION, scenario.ctx());
        let policy_id = object::id(&policy);
        transfer::public_share_object(policy);

        ts::next_tx(scenario, ALICE);
        let workflow = wf::create_workflow(
            b"marketing-funnel-7step-v1",
            b"walrus-blob-12345",
            policy_id,
            150,            // default_price
            9500,           // author_bps
            500,            // platform_bps
            kya_required,
            50,             // min_reputation
            scenario.ctx(),
        );
        let wf_id = object::id(&workflow);
        transfer::public_transfer(workflow, ALICE);
        (policy_id, wf_id)
    }

    #[test]
    fun test_create_and_publish_emits_events() {
        let mut scenario = ts::begin(ALICE);
        let (_policy, _w) = setup(&mut scenario, false);

        ts::next_tx(&mut scenario, ALICE);
        let mut workflow = ts::take_from_sender<Workflow>(&scenario);
        wf::publish_workflow(&mut workflow, scenario.ctx());
        assert!(wf::is_published(&workflow), 0);
        assert!(wf::runs(&workflow) == 0, 1);
        assert!(wf::successful_runs(&workflow) == 0, 2);
        ts::return_to_sender(&scenario, workflow);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = ENotOwner)]
    fun test_publish_by_non_owner_aborts() {
        let mut scenario = ts::begin(ALICE);
        let (_policy, _w) = setup(&mut scenario, false);

        ts::next_tx(&mut scenario, ALICE);
        let mut workflow = ts::take_from_address<Workflow>(&scenario, ALICE);
        ts::next_tx(&mut scenario, BOB);
        wf::publish_workflow(&mut workflow, scenario.ctx()); // aborts ENotOwner
        ts::return_to_address(ALICE, workflow);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = EAlreadyPublished)]
    fun test_double_publish_aborts() {
        let mut scenario = ts::begin(ALICE);
        let (_policy, _w) = setup(&mut scenario, false);

        ts::next_tx(&mut scenario, ALICE);
        let mut workflow = ts::take_from_sender<Workflow>(&scenario);
        wf::publish_workflow(&mut workflow, scenario.ctx());
        wf::publish_workflow(&mut workflow, scenario.ctx()); // aborts
        ts::return_to_sender(&scenario, workflow);
        ts::end(scenario);
    }

    #[test]
    fun test_seal_approve_pay_per_run_happy_path() {
        let mut scenario = ts::begin(ALICE);
        let (_policy_id, w_id) = setup(&mut scenario, false);

        // Publish.
        ts::next_tx(&mut scenario, ALICE);
        let mut workflow = ts::take_from_sender<Workflow>(&scenario);
        wf::publish_workflow(&mut workflow, scenario.ctx());

        // BOB pays + mints fresh subscription (≤ 30s duration ≤ 60s window).
        ts::next_tx(&mut scenario, BOB);
        let policy = ts::take_shared<SubscriptionPolicy>(&scenario);
        let clk = clock::create_for_testing(scenario.ctx());
        let payment = coin::mint_for_testing<SUI>(PRICE, scenario.ctx());
        let sub = sp::subscribe(&policy, payment, &clk, scenario.ctx());

        // Seal approver runs dry — must NOT abort.
        wf::seal_approve_workflow_run(
            object::id_to_bytes(&w_id),
            &workflow,
            &policy,
            &sub,
            &clk,
            option::none(),
        );

        // Cleanup.
        transfer::public_transfer(sub, BOB);
        clock::destroy_for_testing(clk);
        ts::return_shared(policy);
        ts::return_to_address(ALICE, workflow);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = EBadSubscription)]
    fun test_seal_approve_wrong_id_aborts() {
        let mut scenario = ts::begin(ALICE);
        let (_policy_id, _w_id) = setup(&mut scenario, false);

        ts::next_tx(&mut scenario, ALICE);
        let mut workflow = ts::take_from_sender<Workflow>(&scenario);
        wf::publish_workflow(&mut workflow, scenario.ctx());

        ts::next_tx(&mut scenario, BOB);
        let policy = ts::take_shared<SubscriptionPolicy>(&scenario);
        let clk = clock::create_for_testing(scenario.ctx());
        let payment = coin::mint_for_testing<SUI>(PRICE, scenario.ctx());
        let sub = sp::subscribe(&policy, payment, &clk, scenario.ctx());

        // Pass WRONG identity bytes — must abort EBadSubscription.
        wf::seal_approve_workflow_run(
            b"this-is-not-the-workflow-uid",
            &workflow,
            &policy,
            &sub,
            &clk,
            option::none(),
        );

        transfer::public_transfer(sub, BOB);
        clock::destroy_for_testing(clk);
        ts::return_shared(policy);
        ts::return_to_address(ALICE, workflow);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = EPaymentExpired)]
    fun test_seal_approve_over_60s_window_aborts() {
        let mut scenario = ts::begin(ALICE);
        // Use a 90s policy duration — exceeds the 60s per-call window.
        ts::next_tx(&mut scenario, ALICE);
        let policy = sp::create_policy(PRICE, 90_000, scenario.ctx());
        let policy_id = object::id(&policy);
        transfer::public_share_object(policy);

        ts::next_tx(&mut scenario, ALICE);
        let mut workflow = wf::create_workflow(
            b"long-window",
            b"blob",
            policy_id,
            10,
            9500,
            500,
            false,
            0,
            scenario.ctx(),
        );
        let w_id = object::id(&workflow);
        wf::publish_workflow(&mut workflow, scenario.ctx());

        ts::next_tx(&mut scenario, BOB);
        let policy = ts::take_shared<SubscriptionPolicy>(&scenario);
        let clk = clock::create_for_testing(scenario.ctx());
        let payment = coin::mint_for_testing<SUI>(PRICE, scenario.ctx());
        let sub = sp::subscribe(&policy, payment, &clk, scenario.ctx());

        // Subscription is fresh but its *remaining duration* is 90s > 60s window.
        wf::seal_approve_workflow_run(
            object::id_to_bytes(&w_id),
            &workflow,
            &policy,
            &sub,
            &clk,
            option::none(),
        );

        transfer::public_transfer(sub, BOB);
        clock::destroy_for_testing(clk);
        ts::return_shared(policy);
        transfer::public_transfer(workflow, ALICE);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = EKYARequired)]
    fun test_seal_approve_missing_kya_aborts() {
        let mut scenario = ts::begin(ALICE);
        let (_policy_id, w_id) = setup(&mut scenario, true /* kya_required */);

        ts::next_tx(&mut scenario, ALICE);
        let mut workflow = ts::take_from_sender<Workflow>(&scenario);
        wf::publish_workflow(&mut workflow, scenario.ctx());

        ts::next_tx(&mut scenario, BOB);
        let policy = ts::take_shared<SubscriptionPolicy>(&scenario);
        let clk = clock::create_for_testing(scenario.ctx());
        let payment = coin::mint_for_testing<SUI>(PRICE, scenario.ctx());
        let sub = sp::subscribe(&policy, payment, &clk, scenario.ctx());

        // KYA required but caller passes none — must abort.
        wf::seal_approve_workflow_run(
            object::id_to_bytes(&w_id),
            &workflow,
            &policy,
            &sub,
            &clk,
            option::none(),
        );

        transfer::public_transfer(sub, BOB);
        clock::destroy_for_testing(clk);
        ts::return_shared(policy);
        ts::return_to_address(ALICE, workflow);
        ts::end(scenario);
    }

    #[test]
    fun test_register_run_increments_counters() {
        let mut scenario = ts::begin(ALICE);
        let (_policy, _w) = setup(&mut scenario, false);

        ts::next_tx(&mut scenario, ALICE);
        let mut workflow = ts::take_from_sender<Workflow>(&scenario);
        wf::publish_workflow(&mut workflow, scenario.ctx());

        let clk = clock::create_for_testing(scenario.ctx());
        wf::register_run(&mut workflow, true, &clk, scenario.ctx());
        wf::register_run(&mut workflow, false, &clk, scenario.ctx());
        wf::register_run(&mut workflow, true, &clk, scenario.ctx());
        assert!(wf::runs(&workflow) == 3, 0);
        assert!(wf::successful_runs(&workflow) == 2, 1);

        clock::destroy_for_testing(clk);
        ts::return_to_sender(&scenario, workflow);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = EBadSubscription)]
    fun test_create_with_bad_bps_aborts() {
        let mut scenario = ts::begin(ALICE);
        ts::next_tx(&mut scenario, ALICE);
        let policy = sp::create_policy(PRICE, PER_CALL_DURATION, scenario.ctx());
        let policy_id = object::id(&policy);
        transfer::public_share_object(policy);
        ts::next_tx(&mut scenario, ALICE);
        // bps must sum to 10_000 — pass 9000 + 500 → 9500 → aborts.
        let workflow = wf::create_workflow(
            b"bad-bps",
            b"blob",
            policy_id,
            100,
            9000,
            500,
            false,
            0,
            scenario.ctx(),
        );
        transfer::public_transfer(workflow, ALICE);
        ts::end(scenario);
    }
}
