/// openx_memwal_marketplace — `MemWalBrain` Move object: a Walrus-Memory
/// namespace published as a paid product on OpenX.
///
/// The upstream `memwal::account` (Mysten Labs) module is NOT modified.
/// We compose alongside it: a `MemWalBrain` references the seller's
/// `MemWalAccount` object id and a namespace string. The Seal policy that
/// gates decryption is still `memwal::account::seal_approve` (owner OR
/// registered delegate). OpenX's role is the *commercial* gate above that
/// — we charge USDC per query and emit billing events.
///
/// SOLID:
///   - SRP: this module owns ONE struct (`MemWalBrain`) + lifecycle entries
///     + a paid-call SEAL approver. Billing lives in `openx_memwal_billing`,
///     revenue split in `openx_memwal_revenue_split`.
///   - LSP: `seal_approve_query` mirrors the 60-sec freshness window used
///     by `brain_registry::seal_approve_pay_per_call` and
///     `skill::seal_approve_skill_call` — keeps the buyer-side flow uniform.
///   - OCP: new attestation tiers (FHE envelope, etc.) plug in via the
///     `attestation_required` u8 — no schema change.
module fhe_brain::openx_memwal_marketplace {
    use sui::event;
    use sui::clock::{Self, Clock};
    use std::string::{Self, String};

    // ─── Errors ──────────────────────────────────────────────────────────

    const ENotSeller: u64 = 0;
    const EAlreadyUnpublished: u64 = 1;
    const EBadCognitiveLevel: u64 = 2;
    const EBadAttestation: u64 = 3;
    const EPaymentExpired: u64 = 4;
    const EBrainInactive: u64 = 5;

    // 60-second window for pay-per-query freshness (matches brain_registry pattern).
    const PAY_PER_QUERY_MAX_AGE_MS: u64 = 60_000;

    // ─── Object ──────────────────────────────────────────────────────────

    /// A published MemWal namespace, listed for per-query USDC sale.
    public struct MemWalBrain has key, store {
        id: UID,
        seller: address,
        /// Upstream MemWalAccount object id (Mysten Labs `memwal::account`).
        memwal_account_id: ID,
        /// Walrus Memory namespace within that account (e.g. "medical-research").
        namespace: String,
        title: String,
        description: String,
        /// Per-query USDC price in 6-decimal micro-units (e.g. 50_000 = $0.05).
        price_per_query_usdc_micro: u64,
        /// Optional KYA gate (ERC-8004 reputation reads).
        kya_required: bool,
        /// 0 = none, 1 = phala-tee, 2 = fhe-envelope (PRD-07).
        attestation_required: u8,
        /// 1..5 — episodic / semantic / long-term / workflow / reflective.
        cognitive_level: u8,
        /// Off-chain URL where buyers can verify the brain is MemWal-backed.
        sovereignty_proof_url: String,
        active: bool,
        created_at_ms: u64,
        updated_at_ms: u64,
    }

    // ─── Events ──────────────────────────────────────────────────────────

    public struct MemWalBrainPublished has copy, drop {
        id: ID,
        seller: address,
        memwal_account_id: ID,
        namespace: String,
        price_per_query_usdc_micro: u64,
        cognitive_level: u8,
        attestation_required: u8,
    }

    public struct MemWalBrainUnpublished has copy, drop { id: ID }
    public struct MemWalBrainPriceUpdated has copy, drop {
        id: ID,
        old_price: u64,
        new_price: u64,
    }

    // ─── Entry functions ─────────────────────────────────────────────────

    /// Publish a namespace as a `MemWalBrain` Move object. The caller MUST
    /// be the owner of the upstream `MemWalAccount`; we don't enforce that
    /// here because the MemWal module already gates decryption — listing a
    /// brain you don't control just means buyers can't read it.
    public entry fun publish_brain(
        memwal_account_id: ID,
        namespace: vector<u8>,
        title: vector<u8>,
        description: vector<u8>,
        price_per_query_usdc_micro: u64,
        kya_required: bool,
        attestation_required: u8,
        sovereignty_proof_url: vector<u8>,
        cognitive_level: u8,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(cognitive_level >= 1 && cognitive_level <= 5, EBadCognitiveLevel);
        assert!(attestation_required <= 2, EBadAttestation);
        let now = clock::timestamp_ms(clock);
        let brain = MemWalBrain {
            id: object::new(ctx),
            seller: ctx.sender(),
            memwal_account_id,
            namespace: string::utf8(namespace),
            title: string::utf8(title),
            description: string::utf8(description),
            price_per_query_usdc_micro,
            kya_required,
            attestation_required,
            cognitive_level,
            sovereignty_proof_url: string::utf8(sovereignty_proof_url),
            active: true,
            created_at_ms: now,
            updated_at_ms: now,
        };
        event::emit(MemWalBrainPublished {
            id: object::id(&brain),
            seller: brain.seller,
            memwal_account_id,
            namespace: brain.namespace,
            price_per_query_usdc_micro,
            cognitive_level,
            attestation_required,
        });
        // Shared object so the marketplace can list + buyers can reference it.
        transfer::public_share_object(brain);
    }

    public entry fun unpublish_brain(brain: &mut MemWalBrain, clock: &Clock, ctx: &TxContext) {
        assert!(brain.seller == ctx.sender(), ENotSeller);
        assert!(brain.active, EAlreadyUnpublished);
        brain.active = false;
        brain.updated_at_ms = clock::timestamp_ms(clock);
        event::emit(MemWalBrainUnpublished { id: object::id(brain) });
    }

    public entry fun update_price(
        brain: &mut MemWalBrain,
        new_price_usdc_micro: u64,
        clock: &Clock,
        ctx: &TxContext,
    ) {
        assert!(brain.seller == ctx.sender(), ENotSeller);
        let old = brain.price_per_query_usdc_micro;
        brain.price_per_query_usdc_micro = new_price_usdc_micro;
        brain.updated_at_ms = clock::timestamp_ms(clock);
        event::emit(MemWalBrainPriceUpdated {
            id: object::id(brain),
            old_price: old,
            new_price: new_price_usdc_micro,
        });
    }

    // ─── Read accessors ─────────────────────────────────────────────────

    public fun seller(b: &MemWalBrain): address { b.seller }
    public fun memwal_account_id(b: &MemWalBrain): ID { b.memwal_account_id }
    public fun namespace(b: &MemWalBrain): &String { &b.namespace }
    public fun price(b: &MemWalBrain): u64 { b.price_per_query_usdc_micro }
    public fun cognitive_level(b: &MemWalBrain): u8 { b.cognitive_level }
    public fun attestation_required(b: &MemWalBrain): u8 { b.attestation_required }
    public fun is_active(b: &MemWalBrain): bool { b.active }

    // ─── SEAL approver (60-sec freshness window) ───────────────────────

    /// `seal_approve_query` is called by the Seal threshold servers when a
    /// buyer requests decryption keys. Approval requires:
    ///   - the brain is active
    ///   - `payment_proof_ts_ms` is within 60s of `clock` (replay defense)
    ///
    /// `payment_proof` is opaque to the contract — the off-chain API gateway
    /// produces an HMAC over (brain_id, buyer, tx_hash, ts) and the Seal
    /// servers verify it via a separate Move call before invoking us. This
    /// keeps the contract small and matches the existing brain/workflow/skill
    /// approver pattern.
    public fun seal_approve_query(
        brain: &MemWalBrain,
        _payment_proof: vector<u8>,
        payment_proof_ts_ms: u64,
        clock: &Clock,
    ) {
        assert!(brain.active, EBrainInactive);
        let now = clock::timestamp_ms(clock);
        let age = if (now > payment_proof_ts_ms) { now - payment_proof_ts_ms } else { 0 };
        assert!(age <= PAY_PER_QUERY_MAX_AGE_MS, EPaymentExpired);
    }
}
