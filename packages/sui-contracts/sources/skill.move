/// skill — Sui marketplace Skill product type. Standalone single-tool product
/// with one input → one output. Per-call paywall via the same 60-sec freshness
/// pattern as `brain_registry::seal_approve_pay_per_call` and
/// `workflow::seal_approve_workflow_run`.
///
/// SOLID:
///   - SRP: this module owns ONE struct (Skill) + ONE Seal entrypoint.
///   - LSP: identical access-control semantics as the brain + workflow approvers.
///
/// Distinct namespace from `packages/sdk/src/skill/` (parked Solidity CoFHE
/// encrypted-skill-license primitive). Sui marketplace skills live HERE.
module fhe_brain::skill {
    use sui::event;
    use fhe_brain::subscription_policy::{Self as sp, SubscriptionPolicy, Subscription};
    use fhe_brain::kya_gate::{Self as kya, KYAClaim};
    use sui::clock::{Self, Clock};

    const ENotOwner: u64 = 0;
    const EAlreadyPublished: u64 = 1;
    const ENotPublished: u64 = 2;
    const EBadSubscription: u64 = 3;
    const ESubscriptionExpired: u64 = 4;
    const EKYARequired: u64 = 5;
    const EPaymentExpired: u64 = 6;

    const PAY_PER_CALL_MAX_AGE_MS: u64 = 60_000;

    public struct Skill has key, store {
        id: UID,
        author: address,
        skill_key: vector<u8>,
        // Walrus blob holding the canonical signed manifest (input/output schema, endpoint).
        manifest_blob_id: vector<u8>,
        seal_policy_id: ID,
        default_price: u64,
        published: bool,
        kya_required: bool,
        min_reputation: u64,
        invocations: u64,
    }

    public struct SkillCreated has copy, drop {
        id: ID,
        author: address,
        skill_key: vector<u8>,
        seal_policy_id: ID,
    }

    public struct SkillPublished has copy, drop { id: ID }

    public fun create_skill(
        skill_key: vector<u8>,
        manifest_blob_id: vector<u8>,
        seal_policy_id: ID,
        default_price: u64,
        kya_required: bool,
        min_reputation: u64,
        ctx: &mut TxContext,
    ): Skill {
        let s = Skill {
            id: object::new(ctx),
            author: ctx.sender(),
            skill_key,
            manifest_blob_id,
            seal_policy_id,
            default_price,
            published: false,
            kya_required,
            min_reputation,
            invocations: 0,
        };
        event::emit(SkillCreated {
            id: object::id(&s),
            author: s.author,
            skill_key: s.skill_key,
            seal_policy_id,
        });
        s
    }

    public fun publish_skill(s: &mut Skill, ctx: &TxContext) {
        assert!(s.author == ctx.sender(), ENotOwner);
        assert!(!s.published, EAlreadyPublished);
        s.published = true;
        event::emit(SkillPublished { id: object::id(s) });
    }

    public fun register_invocation(s: &mut Skill, ctx: &TxContext) {
        assert!(s.author == ctx.sender(), ENotOwner);
        assert!(s.published, ENotPublished);
        s.invocations = s.invocations + 1;
    }

    fun authorize_call(
        s: &Skill,
        policy: &SubscriptionPolicy,
        sub: &Subscription,
        clock: &Clock,
        kya_claim: Option<KYAClaim>,
    ) {
        assert!(s.published, ENotPublished);
        assert!(sp::policy_id(sub) == object::id(policy), EBadSubscription);
        assert!(object::id(policy) == s.seal_policy_id, EBadSubscription);
        assert!(sp::is_valid(sub, clock), ESubscriptionExpired);
        if (s.kya_required) {
            assert!(kya_claim.is_some(), EKYARequired);
            let claim_ref = kya_claim.borrow();
            assert!(kya::verify(claim_ref, s.min_reputation), EKYARequired);
        };
        let _ = kya_claim;
    }

    /// Per-call SEAL approver. Mirrors brain_registry::seal_approve_pay_per_call
    /// and workflow::seal_approve_workflow_run — same 60-sec window.
    public fun seal_approve_skill_call(
        id: vector<u8>,
        s: &Skill,
        policy: &SubscriptionPolicy,
        sub: &Subscription,
        clock: &Clock,
        kya_claim: Option<KYAClaim>,
    ) {
        let s_id_bytes = object::id(s).to_bytes();
        assert!(id == s_id_bytes, EBadSubscription);
        let now = clock::timestamp_ms(clock);
        let expires = sp::expires_at(sub);
        assert!(expires >= now, ESubscriptionExpired);
        assert!(expires - now <= PAY_PER_CALL_MAX_AGE_MS, EPaymentExpired);
        authorize_call(s, policy, sub, clock, kya_claim);
    }

    public fun manifest_blob_id(s: &Skill): &vector<u8> { &s.manifest_blob_id }
    public fun is_published(s: &Skill): bool { s.published }
    public fun invocations(s: &Skill): u64 { s.invocations }
    public fun author(s: &Skill): address { s.author }
    public fun default_price(s: &Skill): u64 { s.default_price }
    public fun kya_required(s: &Skill): bool { s.kya_required }
    public fun skill_key(s: &Skill): &vector<u8> { &s.skill_key }
}
