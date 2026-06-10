/// SubscriptionPolicy — shared policy object + time-bound Subscription NFT.
///
/// Anyone can subscribe by paying `price_mist` SUI; the payment routes to the
/// policy owner; the subscriber receives a `Subscription` capability that
/// `brain_registry::read_brain` (and Seal key servers in T8) verify against
/// the on-chain `Clock`.
module fhe_brain::subscription_policy {
    use sui::event;
    use sui::coin::{Self, Coin};
    use sui::clock::{Self, Clock};
    use sui::transfer;

    /// Payment too low. Caller must include at least `price_mist`.
    const EInsufficientPayment: u64 = 0;

    /// Shared policy. `share` it via `transfer::public_share_object` after creation.
    public struct SubscriptionPolicy has key, store {
        id: UID,
        owner: address,
        /// Price per subscription in MIST (1 SUI = 1_000_000_000 MIST).
        price_mist: u64,
        /// Subscription validity in milliseconds from purchase.
        duration_ms: u64,
    }

    /// Capability NFT proving an active subscription. Time-bound via `expires_at`.
    public struct Subscription has key, store {
        id: UID,
        policy_id: ID,
        subscriber: address,
        /// Clock-time milliseconds at which the subscription expires.
        expires_at: u64,
    }

    public struct PolicyCreated has copy, drop {
        id: ID,
        owner: address,
        price_mist: u64,
        duration_ms: u64,
    }

    public struct SubscriptionMinted has copy, drop {
        id: ID,
        policy: ID,
        subscriber: address,
        expires_at: u64,
    }

    /// Owner-only — create a policy. Returns it so the caller can `transfer::share` or transfer.
    public fun create_policy(
        price_mist: u64,
        duration_ms: u64,
        ctx: &mut TxContext,
    ): SubscriptionPolicy {
        let policy = SubscriptionPolicy {
            id: object::new(ctx),
            owner: ctx.sender(),
            price_mist,
            duration_ms,
        };
        event::emit(PolicyCreated {
            id: object::id(&policy),
            owner: policy.owner,
            price_mist,
            duration_ms,
        });
        policy
    }

    /// Subscribe by paying `>= price_mist` of any coin type `T`.
    ///
    /// Mock-first: tests call this with `Coin<SUI>`. Real-prod (post-T3 deploy)
    /// instantiates `T` with the mainnet `0x…::usdc::USDC` type so subscriptions
    /// settle in stablecoin and benefit from Sui's protocol-level gasless
    /// stablecoin transfer (live since 2026-05-20). The price unit `price_mist`
    /// is interpreted in the smallest unit of whichever `T` is passed
    /// (1 MIST for SUI, 1e-6 USDC for the USDC type).
    public fun subscribe<T>(
        policy: &SubscriptionPolicy,
        payment: Coin<T>,
        clock: &Clock,
        ctx: &mut TxContext,
    ): Subscription {
        assert!(coin::value(&payment) >= policy.price_mist, EInsufficientPayment);
        transfer::public_transfer(payment, policy.owner);

        let now = clock::timestamp_ms(clock);
        let sub = Subscription {
            id: object::new(ctx),
            policy_id: object::id(policy),
            subscriber: ctx.sender(),
            expires_at: now + policy.duration_ms,
        };
        event::emit(SubscriptionMinted {
            id: object::id(&sub),
            policy: object::id(policy),
            subscriber: sub.subscriber,
            expires_at: sub.expires_at,
        });
        sub
    }

    /// Returns true iff `sub` is unexpired against the live clock.
    public fun is_valid(sub: &Subscription, clock: &Clock): bool {
        clock::timestamp_ms(clock) <= sub.expires_at
    }

    // -------- Read accessors (off-chain consumers) --------------------------

    public fun price_mist(p: &SubscriptionPolicy): u64 { p.price_mist }
    public fun duration_ms(p: &SubscriptionPolicy): u64 { p.duration_ms }
    public fun policy_owner(p: &SubscriptionPolicy): address { p.owner }
    public fun subscriber(s: &Subscription): address { s.subscriber }
    public fun policy_id(s: &Subscription): ID { s.policy_id }
    public fun expires_at(s: &Subscription): u64 { s.expires_at }
}
