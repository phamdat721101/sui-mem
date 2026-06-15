/// openx_loop_x402_router — Mode A settlement (x402 fast lane).
///
/// Atomically consumes a `Coin<T>` (canonical `T = USDC`), reads splits from
/// the `Agent`, and fans out to (seller, compute_treasury, platform_treasury)
/// in 3 inline `public_transfer` calls. Emits `LoopX402Settled` — Sui events
/// are the canonical sovereignty record (no off-chain ledger required).
///
/// Two SEAL approvers gate the Mode A privacy substrate:
///   - `seal_approve_runner_decrypt` — runner asks Seal threshold servers to
///     derive a per-policy decryption capability for the buyer's input. The
///     60-sec freshness window mirrors `openx_memwal_marketplace::seal_approve_query`.
///   - `seal_approve_buyer_decrypt` — buyer derives a decryption capability
///     for the response under the same per-job policy.
///
/// SOLID:
///   - SRP: this module owns `(Coin<T> → 3 transfers + 1 event)` and the two
///     Seal approvers. No agent lookup, no inference, no MemWal write.
///   - DIP: the `X402RouterConfig` shared object holds `compute_treasury` +
///     `platform_treasury` — admin-mutable; settlement reads from it once.
///   - LSP: `settle_and_distribute<T>` is generic so unit tests use SUI and
///     prod uses USDC.
module fhe_brain::openx_loop_x402_router {
    use sui::event;
    use sui::coin::{Self, Coin};
    use sui::clock::{Self, Clock};
    use fhe_brain::openx_loop_agent_registry::{Self as ar, Agent};

    // ─── Errors ──────────────────────────────────────────────────────────

    const EZeroAmount: u64 = 0;
    const EBelowMin: u64 = 1;
    const EPaymentExpired: u64 = 2;
    const ENotBuyer: u64 = 3;
    const ENotAdmin: u64 = 4;

    /// 60-sec freshness window (matches existing `seal_approve_query`).
    const SEAL_FRESHNESS_MAX_AGE_MS: u64 = 60_000;

    // ─── Config ──────────────────────────────────────────────────────────

    public struct X402RouterConfig has key {
        id: UID,
        admin: address,
        compute_treasury: address,
        platform_treasury: address,
        min_micro_usdc: u64,
    }

    /// Module init — creates a shared config. Admin = deployer; can rotate
    /// treasuries / min via `update_*` entry fns.
    fun init(ctx: &mut TxContext) {
        let cfg = X402RouterConfig {
            id: object::new(ctx),
            admin: ctx.sender(),
            compute_treasury: ctx.sender(),
            platform_treasury: ctx.sender(),
            min_micro_usdc: 1_000, // 0.001 USDC floor
        };
        transfer::share_object(cfg);
    }

    public entry fun update_treasuries(
        cfg: &mut X402RouterConfig,
        compute: address,
        platform: address,
        ctx: &TxContext,
    ) {
        assert!(cfg.admin == ctx.sender(), ENotAdmin);
        cfg.compute_treasury = compute;
        cfg.platform_treasury = platform;
    }

    public entry fun update_min(cfg: &mut X402RouterConfig, min_micro: u64, ctx: &TxContext) {
        assert!(cfg.admin == ctx.sender(), ENotAdmin);
        cfg.min_micro_usdc = min_micro;
    }

    // ─── Events ──────────────────────────────────────────────────────────

    public struct LoopX402Settled has copy, drop {
        agent_id: ID,
        buyer: address,
        seller: address,
        total_micro: u64,
        seller_cut_micro: u64,
        compute_cut_micro: u64,
        platform_cut_micro: u64,
        ts_ms: u64,
    }

    // ─── Settlement ──────────────────────────────────────────────────────

    /// Mode A: consume one `Coin<T>`, split 3 ways per agent's manifest, emit
    /// `LoopX402Settled`. Platform absorbs the rounding remainder (≤ 2 µT).
    /// `buyer` is recorded for the event — caller (the platform sponsor in
    /// the typical x402 flow) passes it explicitly so the event identifies
    /// the payer regardless of who submits the tx.
    public entry fun settle_and_distribute<T>(
        cfg: &X402RouterConfig,
        agent: &Agent,
        payment: Coin<T>,
        buyer: address,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        ar::assert_not_revoked(agent);
        let total = coin::value(&payment);
        assert!(total > 0, EZeroAmount);
        let floor = if (ar::per_iter_min(agent) > cfg.min_micro_usdc) ar::per_iter_min(agent) else cfg.min_micro_usdc;
        assert!(total >= floor, EBelowMin);

        let (seller_bps, compute_bps, _platform_bps) = ar::splits(agent);
        let seller_cut = total * (seller_bps as u64) / 10_000;
        let compute_cut = total * (compute_bps as u64) / 10_000;
        let platform_cut = total - seller_cut - compute_cut;

        let mut payment = payment;
        let seller_coin = coin::split(&mut payment, seller_cut, ctx);
        let compute_coin = coin::split(&mut payment, compute_cut, ctx);
        // payment now holds platform_cut after both splits.
        transfer::public_transfer(seller_coin, ar::seller(agent));
        transfer::public_transfer(compute_coin, cfg.compute_treasury);
        transfer::public_transfer(payment, cfg.platform_treasury);

        event::emit(LoopX402Settled {
            agent_id: object::id(agent),
            buyer,
            seller: ar::seller(agent),
            total_micro: total,
            seller_cut_micro: seller_cut,
            compute_cut_micro: compute_cut,
            platform_cut_micro: platform_cut,
            ts_ms: clock::timestamp_ms(clock),
        });
    }

    // ─── Seal approvers (60-sec freshness pattern) ───────────────────────

    /// Runner-side decrypt approver — Seal coordinator off-chain MUST verify
    /// `payment_proof_ts_ms` corresponds to a recent `LoopX402Settled` event
    /// before invoking this. The Move call only enforces the freshness window.
    public fun seal_approve_runner_decrypt(
        _agent: &Agent,
        _payment_proof: vector<u8>,
        payment_proof_ts_ms: u64,
        clock: &Clock,
    ) {
        let now = clock::timestamp_ms(clock);
        let age = if (now > payment_proof_ts_ms) { now - payment_proof_ts_ms } else { 0 };
        assert!(age <= SEAL_FRESHNESS_MAX_AGE_MS, EPaymentExpired);
    }

    /// Buyer-side decrypt approver — proves `ctx.sender() == buyer` who paid.
    public fun seal_approve_buyer_decrypt(buyer: address, ctx: &TxContext) {
        assert!(ctx.sender() == buyer, ENotBuyer);
    }

    // ─── Read accessors ─────────────────────────────────────────────────

    public fun compute_treasury(cfg: &X402RouterConfig): address { cfg.compute_treasury }
    public fun platform_treasury(cfg: &X402RouterConfig): address { cfg.platform_treasury }
    public fun min_micro(cfg: &X402RouterConfig): u64 { cfg.min_micro_usdc }

    #[test_only]
    public fun create_config_for_testing(
        compute: address, platform: address, min_micro: u64, ctx: &mut TxContext,
    ): X402RouterConfig {
        X402RouterConfig {
            id: object::new(ctx), admin: ctx.sender(),
            compute_treasury: compute, platform_treasury: platform, min_micro_usdc: min_micro,
        }
    }

    #[test_only]
    public fun share_config_for_testing(cfg: X402RouterConfig) {
        transfer::share_object(cfg);
    }
}
