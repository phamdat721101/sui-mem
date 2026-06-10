/// agent_module — canonical Sui-side `Agent` record (Brain + Persona, 1:1).
///
/// Persona + pricing are encoded as opaque bytes (a JSON blob); we keep the
/// chain footprint small. The `brain_id` is the Sui Object ID of the
/// underlying `brain_registry::Brain`. Off-chain consumers (the v3 API
/// gateway) read these fields when emitting 402 challenges.
module fhe_brain::agent_module {
    use sui::event;

    const ENotOwner: u64 = 0;
    const EAlreadyPublished: u64 = 1;

    public struct Agent has key, store {
        id: UID,
        owner: address,
        brain_id: ID,
        persona_json: vector<u8>,        // { system_prompt, tools, model }
        pricing_json: vector<u8>,        // { x402, mpp, sui_usdc } as string|null per rail
        kya_required: bool,
        min_reputation: u64,
        published: bool,
    }

    public struct AgentCreated has copy, drop { id: ID, owner: address, brain_id: ID }
    public struct AgentPublished has copy, drop { id: ID }

    public fun create_agent(
        brain_id: ID,
        persona_json: vector<u8>,
        pricing_json: vector<u8>,
        kya_required: bool,
        min_reputation: u64,
        ctx: &mut TxContext,
    ): Agent {
        let agent = Agent {
            id: object::new(ctx),
            owner: ctx.sender(),
            brain_id,
            persona_json,
            pricing_json,
            kya_required,
            min_reputation,
            published: false,
        };
        event::emit(AgentCreated {
            id: object::id(&agent),
            owner: agent.owner,
            brain_id: agent.brain_id,
        });
        agent
    }

    public fun publish_agent(agent: &mut Agent, ctx: &TxContext) {
        assert!(agent.owner == ctx.sender(), ENotOwner);
        assert!(!agent.published, EAlreadyPublished);
        agent.published = true;
        event::emit(AgentPublished { id: object::id(agent) });
    }

    // -------- read accessors -------------------------------------------------
    public fun owner(a: &Agent): address { a.owner }
    public fun brain_id(a: &Agent): ID { a.brain_id }
    public fun persona_json(a: &Agent): &vector<u8> { &a.persona_json }
    public fun pricing_json(a: &Agent): &vector<u8> { &a.pricing_json }
    public fun kya_required(a: &Agent): bool { a.kya_required }
    public fun min_reputation(a: &Agent): u64 { a.min_reputation }
    public fun is_published(a: &Agent): bool { a.published }
}
