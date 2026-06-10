/// KYAGate — Know-Your-Agent claims for ERC-8004 verified agents.
///
/// v1 is a stub verifier: we accept `claim.reputation >= min_reputation` and
/// non-empty proof bytes. T10 swaps the body of `verify` for real ed25519 or
/// ecdsa_k1 signature verification against an off-chain ERC-8004 oracle key.
/// All call sites (e.g. `brain_registry::read_brain`) stay unchanged because
/// only the *body* of `verify` changes.
module fhe_brain::kya_gate {

    /// Verifiable agent claim. Wallet/identity bytes + reputation score (0..100)
    /// + opaque proof bytes signed by the ERC-8004 oracle.
    public struct KYAClaim has copy, drop, store {
        agent_address: vector<u8>,
        reputation: u64,
        proof: vector<u8>,
    }

    public fun new_claim(
        agent_address: vector<u8>,
        reputation: u64,
        proof: vector<u8>,
    ): KYAClaim {
        KYAClaim { agent_address, reputation, proof }
    }

    public fun reputation(c: &KYAClaim): u64 { c.reputation }
    public fun agent_address(c: &KYAClaim): &vector<u8> { &c.agent_address }
    public fun proof(c: &KYAClaim): &vector<u8> { &c.proof }

    /// Stub verifier — accepts when reputation meets threshold AND proof is
    /// non-empty. T10 replaces the body with real signature checking.
    public fun verify(claim: &KYAClaim, min_reputation: u64): bool {
        claim.reputation >= min_reputation && !claim.proof.is_empty()
    }
}
