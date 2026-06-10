/// agent_billing — `pay_per_call` settlement for the Sui-tier agent rail.
///
/// The buyer's tx calls `pay_per_call`, paying `>= price` of any coin type
/// `T`. The function transfers the payment to the agent's `recipient` and
/// emits a `CallPaid` event the off-chain API gateway watches to release
/// the agent's response.
///
/// Mock-first: tests instantiate `T` with `Coin<SUI>`. Real-prod will use
/// `Coin<0x…::usdc::USDC>` once the mainnet Sui USDC package is wired
/// (per docs/V3_PROPOSAL.md mock-first table).
module fhe_brain::agent_billing {
    use sui::event;
    use sui::coin::{Self, Coin};
    use sui::clock::{Self, Clock};
    use sui::transfer;

    const EInsufficientPayment: u64 = 0;

    public struct CallPaid has copy, drop {
        agent_id: ID,
        buyer: address,
        amount: u64,
        recipient: address,
        ts_ms: u64,
    }

    /// Pay `>= price` for one call to `agent_id`. Payment is forwarded to
    /// `recipient`. Returns nothing — off-chain consumers watch `CallPaid`.
    public fun pay_per_call<T>(
        agent_id: ID,
        recipient: address,
        price: u64,
        payment: Coin<T>,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        let value = coin::value(&payment);
        assert!(value >= price, EInsufficientPayment);
        transfer::public_transfer(payment, recipient);
        event::emit(CallPaid {
            agent_id,
            buyer: ctx.sender(),
            amount: value,
            recipient,
            ts_ms: clock::timestamp_ms(clock),
        });
    }
}
