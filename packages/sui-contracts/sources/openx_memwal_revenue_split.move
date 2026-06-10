/// openx_memwal_revenue_split — multi-author royalty split for composed brains.
///
/// One `CompositionPolicy` per `MemWalBrain`. Brain owner sets a vector of
/// `AuthorShare { wallet, bps }` whose values must sum to (10_000 - operator_bps)
/// — operator bps default 500 (5%) but the volume-dial worker may pass a
/// lower value (PRD-09 §11) for high-volume sellers.
///
/// `distribute<T>` is the single entry point that splits one `Coin<T>` USDC
/// payment to N recipients in one tx — used by the settlement worker per
/// 60-second batch.
///
/// SOLID:
///   - SRP: BPS math + Coin fan-out. No event emission beyond the split.
///   - LSP: works for any `Coin<T>`; tests use `Coin<SUI>`, prod uses USDC.
///   - OCP: changing default operator bps = `set_default_operator_bps()`.
module fhe_brain::openx_memwal_revenue_split {
    use sui::event;
    use sui::coin::{Self, Coin};
    use sui::transfer;
    use fhe_brain::openx_memwal_marketplace::{Self as mp, MemWalBrain};

    const EBpsOverflow: u64 = 0;
    const EEmptyAuthors: u64 = 1;
    const ENotSeller: u64 = 2;

    /// Total = 10_000 bps = 100%.
    const BPS_DENOM: u64 = 10_000;

    /// One author's share of post-operator-cut revenue.
    public struct AuthorShare has store, drop, copy {
        wallet: address,
        bps: u64,
    }

    /// Composition policy for a brain. Sum of author bps must equal
    /// `BPS_DENOM - operator_bps_floor` so the operator share is the
    /// remainder of every distribution (paid to ctx.sender() = the
    /// operator wallet at distribute() time).
    public struct CompositionPolicy has key, store {
        id: UID,
        brain_id: ID,
        seller: address,
        authors: vector<AuthorShare>,
        operator_bps_floor: u64,
    }

    public struct CompositionPolicyCreated has copy, drop {
        id: ID,
        brain_id: ID,
        seller: address,
        author_count: u64,
        operator_bps_floor: u64,
    }

    public struct DistributionExecuted has copy, drop {
        brain_id: ID,
        total: u64,
        operator_amount: u64,
        author_count: u64,
    }

    /// Build an `AuthorShare` from raw u64s (caller assembles a vector).
    public fun new_author_share(wallet: address, bps: u64): AuthorShare {
        AuthorShare { wallet, bps }
    }

    /// Set/replace the policy for a brain. Sum of author bps + operator floor
    /// must equal `BPS_DENOM`. Idempotent on (brain_id) — caller can call
    /// this repeatedly to update splits as authors join / leave.
    ///
    /// `entry` form takes parallel primitive vectors so PTBs / sui-cli can
    /// call it directly without constructing structs off-chain. The
    /// non-entry `set_policy_with_authors` accepts the struct vector for
    /// in-Move callers (used by tests).
    public entry fun set_policy(
        brain: &MemWalBrain,
        author_wallets: vector<address>,
        author_bps: vector<u64>,
        operator_bps_floor: u64,
        ctx: &mut TxContext,
    ) {
        let n = author_wallets.length();
        assert!(n == author_bps.length() && n > 0, EEmptyAuthors);
        let mut authors = vector<AuthorShare>[];
        let mut i = 0;
        while (i < n) {
            authors.push_back(AuthorShare {
                wallet: author_wallets[i],
                bps: author_bps[i],
            });
            i = i + 1;
        };
        set_policy_with_authors(brain, authors, operator_bps_floor, ctx);
    }

    /// In-Move helper used by tests + composed callers. Same invariants.
    public fun set_policy_with_authors(
        brain: &MemWalBrain,
        authors: vector<AuthorShare>,
        operator_bps_floor: u64,
        ctx: &mut TxContext,
    ) {
        assert!(mp::seller(brain) == ctx.sender(), ENotSeller);
        assert!(!authors.is_empty(), EEmptyAuthors);
        let total = sum_bps(&authors) + operator_bps_floor;
        assert!(total == BPS_DENOM, EBpsOverflow);

        let policy = CompositionPolicy {
            id: object::new(ctx),
            brain_id: object::id(brain),
            seller: mp::seller(brain),
            authors,
            operator_bps_floor,
        };
        event::emit(CompositionPolicyCreated {
            id: object::id(&policy),
            brain_id: policy.brain_id,
            seller: policy.seller,
            author_count: policy.authors.length(),
            operator_bps_floor,
        });
        transfer::public_share_object(policy);
    }

    /// Split a payment across all authors + the operator. The operator share
    /// is the residual — `ctx.sender()` at distribute() time receives it.
    /// `operator_bps` may be lower than `policy.operator_bps_floor` (volume
    /// dial: 5% → 4% → 3% → 2% based on rolling 30-day query count).
    /// Authors get the remainder pro-rated.
    public entry fun distribute<T>(
        policy: &CompositionPolicy,
        payment: Coin<T>,
        operator_bps: u64,
        ctx: &mut TxContext,
    ) {
        assert!(operator_bps <= policy.operator_bps_floor + 0, EBpsOverflow);
        let total = coin::value(&payment);
        let mut payment = payment;
        // Operator slice — taken first so authors split exactly the residual.
        let operator_amount = total * operator_bps / BPS_DENOM;
        if (operator_amount > 0) {
            let op_coin = coin::split(&mut payment, operator_amount, ctx);
            transfer::public_transfer(op_coin, ctx.sender());
        };

        // Author splits — last author absorbs rounding dust.
        let n = policy.authors.length();
        let mut i = 0;
        while (i < n - 1) {
            let share = &policy.authors[i];
            let amt = total * share.bps / BPS_DENOM;
            if (amt > 0) {
                let c = coin::split(&mut payment, amt, ctx);
                transfer::public_transfer(c, share.wallet);
            };
            i = i + 1;
        };
        // Send whatever is left to the last author. Avoids dust loss + ensures
        // the input `payment` coin is fully consumed (Move forbids dropping it).
        let last = &policy.authors[n - 1];
        transfer::public_transfer(payment, last.wallet);

        event::emit(DistributionExecuted {
            brain_id: policy.brain_id,
            total,
            operator_amount,
            author_count: n,
        });
    }

    fun sum_bps(authors: &vector<AuthorShare>): u64 {
        let mut total = 0u64;
        let mut i = 0;
        let n = authors.length();
        while (i < n) {
            total = total + authors[i].bps;
            i = i + 1;
        };
        total
    }
}
