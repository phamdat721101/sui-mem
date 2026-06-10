/// workflow — L4 Workflow product type. Sibling of `brain_registry::Brain`.
///
/// A `Workflow` represents a runnable, signed DAG of steps the buyer pays
/// for in one execution. The DAG manifest itself lives on Walrus (the
/// `manifest_blob_id` field). Access to the execution key is gated by the
/// same `seal_approve_*` 60-second-freshness pattern as `Brain` per-call —
/// so the Seal threshold key servers can release the wrapping key only
/// after a paid `Subscription` has been minted within the last 60 seconds.
///
/// SOLID:
///   - SRP: this module owns ONE struct (Workflow) + ONE Seal entrypoint.
///   - DIP: shares `SubscriptionPolicy` / `Subscription` / `KYAClaim` with
///     the brain registry so PayRouter does not need a new code path.
///   - LSP: caller code that already understands the `seal_approve_pay_per_call`
///     pattern (60-sec freshness, same KYA gate) reads identically here.
module fhe_brain::workflow {
    use sui::event;
    use fhe_brain::subscription_policy::{Self as sp, SubscriptionPolicy, Subscription};
    use fhe_brain::kya_gate::{Self as kya, KYAClaim};
    use sui::clock::{Self, Clock};

    // --- error codes (numeric values match brain_registry where shared) ----
    const ENotOwner: u64 = 0;
    const EAlreadyPublished: u64 = 1;
    const ENotPublished: u64 = 2;
    const EBadSubscription: u64 = 3;
    const ESubscriptionExpired: u64 = 4;
    const EKYARequired: u64 = 5;
    const EPaymentExpired: u64 = 6;

    /// Max age between subscription mint and key release for per-execution flow.
    /// Same window as `brain_registry::seal_approve_pay_per_call`.
    const PAY_PER_RUN_MAX_AGE_MS: u64 = 60_000;

    /// L4 workflow product object. `manifest_blob_id` points at the Walrus
    /// blob holding the canonical signed DAG (steps, schemas, revenue split).
    public struct Workflow has key, store {
        id: UID,
        author: address,
        workflow_key: vector<u8>,
        manifest_blob_id: vector<u8>,        // Walrus blob holding full DAG
        seal_policy_id: ID,                  // gates execution-key release
        default_price: u64,                  // smallest unit of paying coin
        author_bps: u16,                     // 9500 = 95% of fee (post-platform)
        platform_bps: u16,                   // 500  = 5% to OpenX
        published: bool,
        kya_required: bool,
        min_reputation: u64,
        runs: u64,                           // total executions counted
        successful_runs: u64,                // input to L5 reflective promotion
    }

    public struct WorkflowCreated has copy, drop {
        id: ID,
        author: address,
        workflow_key: vector<u8>,
        seal_policy_id: ID,
    }

    public struct WorkflowPublished has copy, drop { id: ID }

    public struct WorkflowExecuted has copy, drop {
        id: ID,
        success: bool,
        runs: u64,
        successful_runs: u64,
        ts_ms: u64,
    }

    /// Create an unpublished workflow bound to `seal_policy_id`. Caller owns it.
    public fun create_workflow(
        workflow_key: vector<u8>,
        manifest_blob_id: vector<u8>,
        seal_policy_id: ID,
        default_price: u64,
        author_bps: u16,
        platform_bps: u16,
        kya_required: bool,
        min_reputation: u64,
        ctx: &mut TxContext,
    ): Workflow {
        // Defensive: bps must sum to 10_000.
        assert!((author_bps as u64) + (platform_bps as u64) == 10_000, EBadSubscription);
        let wf = Workflow {
            id: object::new(ctx),
            author: ctx.sender(),
            workflow_key,
            manifest_blob_id,
            seal_policy_id,
            default_price,
            author_bps,
            platform_bps,
            published: false,
            kya_required,
            min_reputation,
            runs: 0,
            successful_runs: 0,
        };
        event::emit(WorkflowCreated {
            id: object::id(&wf),
            author: wf.author,
            workflow_key: wf.workflow_key,
            seal_policy_id,
        });
        wf
    }

    /// Publish to the marketplace catalog. Owner-only. Idempotent guard.
    public fun publish_workflow(wf: &mut Workflow, ctx: &TxContext) {
        assert!(wf.author == ctx.sender(), ENotOwner);
        assert!(!wf.published, EAlreadyPublished);
        wf.published = true;
        event::emit(WorkflowPublished { id: object::id(wf) });
    }

    /// Off-chain WorkflowRunner calls this after a run completes, to update
    /// the success counters that feed L5 reflective promotion. Author-only;
    /// the runner runs as the author's session signer (or PayRouter agent).
    public fun register_run(
        wf: &mut Workflow,
        success: bool,
        clock: &Clock,
        ctx: &TxContext,
    ) {
        assert!(wf.author == ctx.sender(), ENotOwner);
        assert!(wf.published, ENotPublished);
        wf.runs = wf.runs + 1;
        if (success) {
            wf.successful_runs = wf.successful_runs + 1;
        };
        event::emit(WorkflowExecuted {
            id: object::id(wf),
            success,
            runs: wf.runs,
            successful_runs: wf.successful_runs,
            ts_ms: clock::timestamp_ms(clock),
        });
    }

    /// Internal authorize. Same check shape as brain_registry::authorize_read.
    fun authorize_run(
        wf: &Workflow,
        policy: &SubscriptionPolicy,
        sub: &Subscription,
        clock: &Clock,
        kya_claim: Option<KYAClaim>,
    ) {
        assert!(wf.published, ENotPublished);
        assert!(sp::policy_id(sub) == object::id(policy), EBadSubscription);
        assert!(object::id(policy) == wf.seal_policy_id, EBadSubscription);
        assert!(sp::is_valid(sub, clock), ESubscriptionExpired);
        if (wf.kya_required) {
            assert!(kya_claim.is_some(), EKYARequired);
            let claim_ref = kya_claim.borrow();
            assert!(kya::verify(claim_ref, wf.min_reputation), EKYARequired);
        };
        let _ = kya_claim;
    }

    /// Canonical Seal entrypoint for per-execution workflow access.
    /// The Seal threshold key servers fetch the transaction kind that calls
    /// this function and run it dry against the Sui RPC; if it does not abort,
    /// they release the workflow's wrapping key share. The IBE identity bytes
    /// MUST match the workflow UID (prevents cross-workflow key release).
    ///
    /// 60-sec window enforced HERE (not in `subscribe`) — workflow callers
    /// MUST mint a fresh per-call subscription with `duration_ms <= 60_000`.
    public fun seal_approve_workflow_run(
        id: vector<u8>,
        wf: &Workflow,
        policy: &SubscriptionPolicy,
        sub: &Subscription,
        clock: &Clock,
        kya_claim: Option<KYAClaim>,
    ) {
        let wf_id_bytes = object::id(wf).to_bytes();
        assert!(id == wf_id_bytes, EBadSubscription);

        let now = clock::timestamp_ms(clock);
        let expires = sp::expires_at(sub);
        assert!(expires >= now, ESubscriptionExpired);
        assert!(expires - now <= PAY_PER_RUN_MAX_AGE_MS, EPaymentExpired);

        authorize_run(wf, policy, sub, clock, kya_claim);
    }

    // --- read accessors ----------------------------------------------------

    public fun manifest_blob_id(w: &Workflow): &vector<u8> { &w.manifest_blob_id }
    public fun seal_policy_id(w: &Workflow): ID { w.seal_policy_id }
    public fun is_published(w: &Workflow): bool { w.published }
    public fun runs(w: &Workflow): u64 { w.runs }
    public fun successful_runs(w: &Workflow): u64 { w.successful_runs }
    public fun author(w: &Workflow): address { w.author }
    public fun default_price(w: &Workflow): u64 { w.default_price }
    public fun author_bps(w: &Workflow): u16 { w.author_bps }
    public fun platform_bps(w: &Workflow): u16 { w.platform_bps }
    public fun kya_required(w: &Workflow): bool { w.kya_required }
    public fun min_reputation(w: &Workflow): u64 { w.min_reputation }
    public fun workflow_key(w: &Workflow): &vector<u8> { &w.workflow_key }
}
