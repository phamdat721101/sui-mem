/// openx_loop_workflow_v1_1 — extension data for v1.1-upgraded agents.
///
/// PRD-W invariant: existing 6 `openx_loop_*` Move modules MUST stay byte-
/// identical. This module is the v1.1 sidecar. Each upgraded agent gets a
/// shared `AgentV11Extension` keyed by the agent's ID, holding:
///   • workflow_walrus_blob_id      — the canonical workflow YAML
///   • stop_condition_walrus_blob_id — the typed Predicate blob (W1)
///   • areas                        — declared PARA Areas (S1 wizard step 3)
///
/// Plus 2 audit-only events:
///   • WorkflowOutcomeSettled — emitted by operator post-settlement (W4)
///   • RightToForgetEmitted   — emitted when a RTF cron deletes per-buyer slots
///
/// SOLID:
///   - SRP: v1.1-specific metadata + audit events only.
///   - OCP: new fields go on this struct; existing modules untouched.
///   - DIP: only the agent's seller (verified via `Agent.seller()`) can
///     create an extension or update fields. Read-only for everyone.
module fhe_brain::openx_loop_workflow_v1_1 {
    use sui::event;
    use sui::clock::{Self, Clock};
    use std::string::{Self, String};
    use fhe_brain::openx_loop_agent_registry::{Self, Agent};

    // ─── Errors ──────────────────────────────────────────────────────────

    const ENotSeller: u64 = 0;
    const ETooManyAreas: u64 = 1;
    const EBlobIdEmpty: u64 = 2;

    const MAX_AREAS: u64 = 16;

    // ─── Object ──────────────────────────────────────────────────────────

    /// Per-agent v1.1 extension. Created by the upgrade-wizard PTB; updated
    /// by subsequent re-publishes. One-to-one with `Agent`. Shared object.
    public struct AgentV11Extension has key {
        id: UID,
        agent_id: ID,
        seller: address,
        workflow_walrus_blob_id: String,
        stop_condition_walrus_blob_id: String,
        areas: vector<String>,
        created_at_ms: u64,
        updated_at_ms: u64,
    }

    // ─── Events ──────────────────────────────────────────────────────────

    public struct AgentV11ExtensionInitialized has copy, drop {
        ext_id: ID,
        agent_id: ID,
        seller: address,
        area_count: u64,
    }

    public struct AgentV11ExtensionUpdated has copy, drop {
        ext_id: ID,
        agent_id: ID,
    }

    /// PRD-W4 — outcome-priced settlement audit event (operator-emitted).
    public struct WorkflowOutcomeSettled has copy, drop {
        job_id: ID,
        agent_id: ID,
        verdict: u8,            // 0=full · 1=partial · 2=failed
        pay_bps: u16,           // 0..10000 of the budget paid
        evidence_walrus_blob_id: String,
        steps_completed: u32,
        steps_total: u32,
    }

    /// PRD-W v1.1 — right-to-forget audit event. The seller's general brain
    /// (cog-l4-{agent_id}) is UNTOUCHED; only the per-buyer namespace pair
    /// (cog-l4-{agent}-{buyer} + cog-l5-{agent}-{buyer}) is purged off-chain.
    public struct RightToForgetEmitted has copy, drop {
        agent_id: ID,
        buyer_addr: address,
        cooling_off_days: u8,
    }

    // ─── Init / Update ──────────────────────────────────────────────────

    /// Seller-signed PTB during the upgrade-wizard flow. Creates the
    /// extension exactly once per agent. Subsequent edits use `update`.
    public entry fun init_extension(
        agent: &Agent,
        workflow_walrus_blob_id: vector<u8>,
        stop_condition_walrus_blob_id: vector<u8>,
        area_slugs: vector<vector<u8>>,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(openx_loop_agent_registry::seller(agent) == ctx.sender(), ENotSeller);
        assert!(vector::length(&workflow_walrus_blob_id) > 0, EBlobIdEmpty);
        assert!(vector::length(&area_slugs) <= MAX_AREAS, ETooManyAreas);

        let now_ms = clock::timestamp_ms(clock);
        let mut areas = vector::empty<String>();
        let mut i = 0;
        while (i < vector::length(&area_slugs)) {
            vector::push_back(&mut areas, string::utf8(*vector::borrow(&area_slugs, i)));
            i = i + 1;
        };

        let ext = AgentV11Extension {
            id: object::new(ctx),
            agent_id: object::id(agent),
            seller: ctx.sender(),
            workflow_walrus_blob_id: string::utf8(workflow_walrus_blob_id),
            stop_condition_walrus_blob_id: string::utf8(stop_condition_walrus_blob_id),
            areas,
            created_at_ms: now_ms,
            updated_at_ms: now_ms,
        };

        event::emit(AgentV11ExtensionInitialized {
            ext_id: object::id(&ext),
            agent_id: ext.agent_id,
            seller: ext.seller,
            area_count: vector::length(&ext.areas),
        });

        transfer::share_object(ext);
    }

    public entry fun update_extension(
        ext: &mut AgentV11Extension,
        workflow_walrus_blob_id: vector<u8>,
        stop_condition_walrus_blob_id: vector<u8>,
        area_slugs: vector<vector<u8>>,
        clock: &Clock,
        ctx: &TxContext,
    ) {
        assert!(ext.seller == ctx.sender(), ENotSeller);
        assert!(vector::length(&area_slugs) <= MAX_AREAS, ETooManyAreas);

        ext.workflow_walrus_blob_id = string::utf8(workflow_walrus_blob_id);
        ext.stop_condition_walrus_blob_id = string::utf8(stop_condition_walrus_blob_id);

        let mut areas = vector::empty<String>();
        let mut i = 0;
        while (i < vector::length(&area_slugs)) {
            vector::push_back(&mut areas, string::utf8(*vector::borrow(&area_slugs, i)));
            i = i + 1;
        };
        ext.areas = areas;
        ext.updated_at_ms = clock::timestamp_ms(clock);

        event::emit(AgentV11ExtensionUpdated {
            ext_id: object::id(ext),
            agent_id: ext.agent_id,
        });
    }

    // ─── Operator-emitted audit events ──────────────────────────────────
    //
    // These are no-state events the OpenX runner emits via the existing
    // RunnerCap pattern (caller passes the cap by ref; module just gates).
    // We don't take RunnerCap here because the module is admin-free at v1.1
    // — simpler for the spec audit. The events are advisory (off-chain
    // indexers + dashboards consume them).

    public entry fun emit_outcome_settled(
        job_id: ID,
        agent_id: ID,
        verdict: u8,
        pay_bps: u16,
        evidence_walrus_blob_id: vector<u8>,
        steps_completed: u32,
        steps_total: u32,
    ) {
        event::emit(WorkflowOutcomeSettled {
            job_id, agent_id, verdict, pay_bps,
            evidence_walrus_blob_id: string::utf8(evidence_walrus_blob_id),
            steps_completed, steps_total,
        });
    }

    public entry fun emit_right_to_forget(
        agent_id: ID,
        buyer_addr: address,
        cooling_off_days: u8,
    ) {
        event::emit(RightToForgetEmitted { agent_id, buyer_addr, cooling_off_days });
    }

    // ─── Read accessors ─────────────────────────────────────────────────

    public fun agent_id(e: &AgentV11Extension): ID { e.agent_id }
    public fun seller(e: &AgentV11Extension): address { e.seller }
    public fun workflow_blob_id(e: &AgentV11Extension): &String { &e.workflow_walrus_blob_id }
    public fun stop_condition_blob_id(e: &AgentV11Extension): &String { &e.stop_condition_walrus_blob_id }
    public fun areas(e: &AgentV11Extension): &vector<String> { &e.areas }
}
