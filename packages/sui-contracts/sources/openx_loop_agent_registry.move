/// openx_loop_agent_registry — `Agent` shared object for OpenX Loops.
///
/// An *agent* is a persona-bound *job spec* (manifest blob, persona prompt,
/// per-iter price, max iters, splits) — distinct from a `MemWalBrain` which
/// is the *knowledge-base* product. Loops sell *jobs*, brains sell *queries*.
///
/// Sui-native gasless publish: `publish_agent` records `seller = ctx.sender()`,
/// which under Sui sponsored transactions is the *user authority*, never the
/// gas owner. No EIP-712 + relayer pattern needed (Drift #2 closed natively).
///
/// SOLID:
///   - SRP: this module owns the `Agent` struct + lifecycle. Settlement lives
///     in `openx_loop_x402_router`; escrow lives in `openx_loop_job`.
///   - DIP: `record_job_completion` requires a `RunnerCap` capability passed
///     by reference — runners are bootstrapped by the platform admin.
///   - LSP: `seller(&Agent)`, `splits(&Agent)`, `is_revoked(&Agent)` mirror
///     the read shape of `openx_memwal_marketplace::seller(&MemWalBrain)` so
///     downstream code (paymentGate, dashboards) is uniform.
module fhe_brain::openx_loop_agent_registry {
    use sui::event;
    use sui::clock::{Self, Clock};
    use std::string::{Self, String};

    // ─── Errors ──────────────────────────────────────────────────────────

    const ENotSeller: u64 = 0;
    const EAlreadyRevoked: u64 = 1;
    const EBadSplits: u64 = 2;
    const EPricingBelowMin: u64 = 3;
    const EMaxIterOutOfRange: u64 = 4;
    const ERevoked: u64 = 5;
    const ENotAdmin: u64 = 6;

    /// Hard cap on iterations per loop hire (matches arb-mem v0.0).
    const MAX_ITER_HARD_CAP: u64 = 50;
    /// Total bps (100 %).
    const BPS_DENOM: u16 = 10_000;

    // ─── Capabilities ────────────────────────────────────────────────────

    /// Admin-bootstrapped capability that grants `record_job_completion`.
    /// One global cap held by the platform runner wallet.
    public struct RunnerCap has key, store { id: UID }

    /// Module-level admin capability (created once at deploy).
    public struct AdminCap has key, store { id: UID }

    // ─── Object ──────────────────────────────────────────────────────────

    /// A published loop agent — shared object, callable by any wallet.
    public struct Agent has key, store {
        id: UID,
        seller: address,
        /// Walrus blob id for the canonical manifest YAML.
        manifest_walrus_blob_id: String,
        default_inference_backend: String,   // e.g. "phala-tee"
        default_model_id: String,            // e.g. "claude-opus-4.6"
        per_iter_min_micro_usdc: u64,
        per_iter_default_micro_usdc: u64,
        max_iter_per_job: u64,
        seller_bps: u16,
        compute_bps: u16,
        platform_bps: u16,
        reputation_score: u64,   // 0..10_000 (EWMA; bps)
        completed_jobs: u64,
        total_iter_count: u64,
        published_at_ms: u64,
        revoked: bool,
    }

    // ─── Events ──────────────────────────────────────────────────────────

    public struct LoopAgentPublished has copy, drop {
        id: ID,
        seller: address,
        manifest_walrus_blob_id: String,
        per_iter_default_micro_usdc: u64,
        max_iter_per_job: u64,
        seller_bps: u16,
        compute_bps: u16,
        platform_bps: u16,
    }

    public struct LoopAgentRevoked has copy, drop { id: ID }

    public struct LoopAgentReputationUpdated has copy, drop {
        id: ID,
        reputation_score: u64,
        completed_jobs: u64,
    }

    // ─── Init (deploy) ───────────────────────────────────────────────────

    /// Module init — mints the AdminCap to the deployer.
    fun init(ctx: &mut TxContext) {
        transfer::public_transfer(AdminCap { id: object::new(ctx) }, ctx.sender());
    }

    /// Admin mints a RunnerCap and transfers to the runner wallet.
    public entry fun grant_runner_cap(_admin: &AdminCap, runner: address, ctx: &mut TxContext) {
        transfer::public_transfer(RunnerCap { id: object::new(ctx) }, runner);
    }

    // ─── Entry functions ─────────────────────────────────────────────────

    /// Publish an Agent. Splits must sum to 10_000. Sui sponsored-tx-safe:
    /// `ctx.sender()` is the user authority, never the gas owner.
    public entry fun publish_agent(
        manifest_walrus_blob_id: vector<u8>,
        default_inference_backend: vector<u8>,
        default_model_id: vector<u8>,
        per_iter_min_micro_usdc: u64,
        per_iter_default_micro_usdc: u64,
        max_iter_per_job: u64,
        seller_bps: u16,
        compute_bps: u16,
        platform_bps: u16,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(per_iter_default_micro_usdc >= per_iter_min_micro_usdc, EPricingBelowMin);
        assert!(max_iter_per_job > 0 && max_iter_per_job <= MAX_ITER_HARD_CAP, EMaxIterOutOfRange);
        assert!(
            (seller_bps as u64) + (compute_bps as u64) + (platform_bps as u64) == (BPS_DENOM as u64),
            EBadSplits,
        );

        let agent = Agent {
            id: object::new(ctx),
            seller: ctx.sender(),
            manifest_walrus_blob_id: string::utf8(manifest_walrus_blob_id),
            default_inference_backend: string::utf8(default_inference_backend),
            default_model_id: string::utf8(default_model_id),
            per_iter_min_micro_usdc,
            per_iter_default_micro_usdc,
            max_iter_per_job,
            seller_bps,
            compute_bps,
            platform_bps,
            reputation_score: 0,
            completed_jobs: 0,
            total_iter_count: 0,
            published_at_ms: clock::timestamp_ms(clock),
            revoked: false,
        };
        event::emit(LoopAgentPublished {
            id: object::id(&agent),
            seller: agent.seller,
            manifest_walrus_blob_id: agent.manifest_walrus_blob_id,
            per_iter_default_micro_usdc,
            max_iter_per_job,
            seller_bps,
            compute_bps,
            platform_bps,
        });
        transfer::public_share_object(agent);
    }

    public entry fun revoke_agent(agent: &mut Agent, ctx: &TxContext) {
        assert!(agent.seller == ctx.sender(), ENotSeller);
        assert!(!agent.revoked, EAlreadyRevoked);
        agent.revoked = true;
        event::emit(LoopAgentRevoked { id: object::id(agent) });
    }

    /// EWMA reputation update (satisfaction in bps). Runner-only.
    public entry fun record_job_completion(
        _runner: &RunnerCap,
        agent: &mut Agent,
        iter_count: u64,
        satisfaction_bps: u64,
    ) {
        agent.completed_jobs = agent.completed_jobs + 1;
        agent.total_iter_count = agent.total_iter_count + iter_count;
        // EWMA: new = 0.9*old + 0.1*observation.
        let new_score = (agent.reputation_score * 9 + satisfaction_bps) / 10;
        agent.reputation_score = new_score;
        event::emit(LoopAgentReputationUpdated {
            id: object::id(agent),
            reputation_score: new_score,
            completed_jobs: agent.completed_jobs,
        });
    }

    // ─── Read accessors ─────────────────────────────────────────────────

    public fun seller(a: &Agent): address { a.seller }
    public fun manifest(a: &Agent): &String { &a.manifest_walrus_blob_id }
    public fun per_iter_default(a: &Agent): u64 { a.per_iter_default_micro_usdc }
    public fun per_iter_min(a: &Agent): u64 { a.per_iter_min_micro_usdc }
    public fun max_iter(a: &Agent): u64 { a.max_iter_per_job }
    public fun splits(a: &Agent): (u16, u16, u16) { (a.seller_bps, a.compute_bps, a.platform_bps) }
    public fun is_revoked(a: &Agent): bool { a.revoked }
    public fun reputation(a: &Agent): u64 { a.reputation_score }
    public fun completed_jobs(a: &Agent): u64 { a.completed_jobs }

    /// Internal hook — used by `openx_loop_x402_router` to assert non-revoked
    /// without opening up `is_revoked` to non-loop modules. Module-friend
    /// pattern would be cleaner once Move stabilises `friend` semantics; for
    /// now the public read is sufficient.
    public fun assert_not_revoked(a: &Agent) {
        assert!(!a.revoked, ERevoked);
    }

    #[test_only]
    public fun mint_admin_cap_for_testing(ctx: &mut TxContext): AdminCap {
        AdminCap { id: object::new(ctx) }
    }

    #[test_only]
    public fun mint_runner_cap_for_testing(ctx: &mut TxContext): RunnerCap {
        RunnerCap { id: object::new(ctx) }
    }

    #[test_only]
    public fun destroy_admin_cap_for_testing(c: AdminCap) {
        let AdminCap { id } = c;
        object::delete(id);
    }

    #[test_only]
    public fun destroy_runner_cap_for_testing(c: RunnerCap) {
        let RunnerCap { id } = c;
        object::delete(id);
    }
}
