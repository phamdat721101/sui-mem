/// reflective — L5 ReflectiveTrace product type.
///
/// A `ReflectiveTrace` is the agent's metacognition: rules induced from
/// success/failure observations of an L4 workflow. Sold as a one-time license
/// (not per-call) — the buyer holds a `License` capability that is checked
/// when they run the parent workflow.
///
/// SOLID:
///   - SRP: trace + license-unlock approver only.
///   - LSP: same access-control shape (subscription-based mint of License),
///     but with longer (license-lifetime) duration than per-call.
module fhe_brain::reflective {
    use sui::event;
    use fhe_brain::subscription_policy::{Self as sp, SubscriptionPolicy, Subscription};
    use sui::clock::{Self, Clock};

    const ENotOwner: u64 = 0;
    const EAlreadyPublished: u64 = 1;
    const ENotPublished: u64 = 2;
    const EBadSubscription: u64 = 3;
    const ESubscriptionExpired: u64 = 4;

    /// L5 trace object. `rules_blob_id` points at the Walrus blob holding
    /// the canonical signed rules manifest.
    public struct ReflectiveTrace has key, store {
        id: UID,
        author: address,
        trace_key: vector<u8>,
        // The L4 Workflow's Sui object id this trace reflects on.
        workflow_id: ID,
        rules_blob_id: vector<u8>,
        seal_policy_id: ID,
        license_price: u64,
        published: bool,
        runs_observed: u64,
        licenses_sold: u64,
    }

    /// One-time capability proving the holder licensed this trace.
    /// Transferable; the workflow runner reads this object to apply the rules.
    public struct License has key, store {
        id: UID,
        trace_id: ID,
        licensee: address,
        ts_ms: u64,
    }

    public struct ReflectiveCreated has copy, drop {
        id: ID,
        author: address,
        trace_key: vector<u8>,
        workflow_id: ID,
    }

    public struct ReflectivePublished has copy, drop { id: ID }

    public struct LicenseMinted has copy, drop {
        license: ID,
        trace: ID,
        licensee: address,
    }

    public fun create_trace(
        trace_key: vector<u8>,
        workflow_id: ID,
        rules_blob_id: vector<u8>,
        seal_policy_id: ID,
        license_price: u64,
        runs_observed: u64,
        ctx: &mut TxContext,
    ): ReflectiveTrace {
        let t = ReflectiveTrace {
            id: object::new(ctx),
            author: ctx.sender(),
            trace_key,
            workflow_id,
            rules_blob_id,
            seal_policy_id,
            license_price,
            published: false,
            runs_observed,
            licenses_sold: 0,
        };
        event::emit(ReflectiveCreated {
            id: object::id(&t),
            author: t.author,
            trace_key: t.trace_key,
            workflow_id,
        });
        t
    }

    public fun publish_trace(t: &mut ReflectiveTrace, ctx: &TxContext) {
        assert!(t.author == ctx.sender(), ENotOwner);
        assert!(!t.published, EAlreadyPublished);
        t.published = true;
        event::emit(ReflectivePublished { id: object::id(t) });
    }

    /// Mint a License after caller has paid via subscription_policy::subscribe.
    /// The seal_approve_license_unlock entrypoint does the same checks; this
    /// is the on-chain mint that produces the holder's capability.
    public fun mint_license(
        t: &mut ReflectiveTrace,
        sub: &Subscription,
        clock: &Clock,
        ctx: &mut TxContext,
    ): License {
        assert!(t.published, ENotPublished);
        assert!(sp::is_valid(sub, clock), ESubscriptionExpired);
        t.licenses_sold = t.licenses_sold + 1;
        let lic = License {
            id: object::new(ctx),
            trace_id: object::id(t),
            licensee: ctx.sender(),
            ts_ms: clock::timestamp_ms(clock),
        };
        event::emit(LicenseMinted {
            license: object::id(&lic),
            trace: object::id(t),
            licensee: ctx.sender(),
        });
        lic
    }

    /// Seal approver — the off-chain runner uses this to confirm the buyer's
    /// fresh subscription before releasing the rules-decryption key. License
    /// unlocks aren't subject to the 60s window; the policy itself can
    /// configure a multi-day duration so the buyer's License object stays
    /// usable across many workflow runs.
    public fun seal_approve_license_unlock(
        id: vector<u8>,
        t: &ReflectiveTrace,
        policy: &SubscriptionPolicy,
        sub: &Subscription,
        clock: &Clock,
    ) {
        let trace_id_bytes = object::id(t).to_bytes();
        assert!(id == trace_id_bytes, EBadSubscription);
        assert!(t.published, ENotPublished);
        assert!(sp::policy_id(sub) == object::id(policy), EBadSubscription);
        assert!(object::id(policy) == t.seal_policy_id, EBadSubscription);
        assert!(sp::is_valid(sub, clock), ESubscriptionExpired);
    }

    public fun rules_blob_id(t: &ReflectiveTrace): &vector<u8> { &t.rules_blob_id }
    public fun is_published(t: &ReflectiveTrace): bool { t.published }
    public fun runs_observed(t: &ReflectiveTrace): u64 { t.runs_observed }
    public fun licenses_sold(t: &ReflectiveTrace): u64 { t.licenses_sold }
    public fun author(t: &ReflectiveTrace): address { t.author }
    public fun license_price(t: &ReflectiveTrace): u64 { t.license_price }
    public fun workflow_id(t: &ReflectiveTrace): ID { t.workflow_id }
    public fun license_trace_id(l: &License): ID { l.trace_id }
    public fun license_licensee(l: &License): address { l.licensee }
}
