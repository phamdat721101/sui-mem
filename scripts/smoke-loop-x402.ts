/**
 * scripts/smoke-loop-x402.ts — Mode A 402 dance smoke.
 *
 * Exercises `POST /v3/loop/agents/:id/invoke` end-to-end against the local
 * Express server (`npm run api:dev`). Does NOT submit on-chain — verifies
 * the *envelope* shape, the HMAC challenge, and the replay-defence path.
 *
 * What it asserts:
 *   1. No X-PAYMENT → 402 with `ptb_bytes_b64` + `challenge_id`.
 *   2. Tampered ptb_bytes_b64 → 402 `code: replay_or_tamper`.
 *   3. Wrong payer → 402 `code: bad_payer`.
 *
 * Steps that a real flow does (deferred to a live-testnet smoke):
 *   - Sign the PTB with a real Sui keypair.
 *   - Sponsor co-signs and submits.
 *   - Asserts on-chain `LoopX402Settled` event.
 *
 * Run:
 *   OPENX_API_URL=http://localhost:3001 \
 *   OPENX_LOOP_TEST_AGENT_ID=0xabc... \
 *   npm run smoke:loop-x402
 */

const API = process.env.OPENX_API_URL ?? 'http://localhost:3001';
const AGENT = process.env.OPENX_LOOP_TEST_AGENT_ID ?? '0xagent';
const BUYER = process.env.OPENX_LOOP_TEST_BUYER ?? '0xbuyer000000000000000000000000000000000001';
const COIN = process.env.OPENX_LOOP_TEST_COIN ?? '0xcoin000000000000000000000000000000000001';

async function step(label: string, fn: () => Promise<unknown>): Promise<void> {
  process.stdout.write(`  ${label} … `);
  try {
    await fn();
    process.stdout.write('OK\n');
  } catch (e) {
    process.stdout.write(`FAIL\n    ${(e as Error).message}\n`);
    process.exit(1);
  }
}

async function main() {
  console.log(`smoke-loop-x402 → ${API} agent=${AGENT}`);

  let envelope: { ptb_bytes_b64: string; challenge_id: string; agent_object_id: string } | null = null;

  await step('GET 402 challenge envelope', async () => {
    const r = await fetch(`${API}/v3/loop/agents/${AGENT}/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-wallet-address': BUYER },
      body: JSON.stringify({ buyer_address: BUYER, payment_coin_object_id: COIN }),
    });
    if (r.status !== 402) throw new Error(`expected 402, got ${r.status}: ${await r.text()}`);
    const body = (await r.json()) as { ptb_bytes_b64?: string; challenge_id?: string; agent_object_id?: string };
    if (!body.ptb_bytes_b64 || !body.challenge_id) throw new Error('envelope missing keys');
    envelope = body as { ptb_bytes_b64: string; challenge_id: string; agent_object_id: string };
  });

  await step('Tampered ptb → 402 replay_or_tamper', async () => {
    if (!envelope) throw new Error('no envelope');
    const tampered = Buffer.from('garbagebytes').toString('base64');
    const xPayment = Buffer.from(
      JSON.stringify({
        ptb_bytes_b64: tampered,
        buyer_signature: 'AAAA',
        challenge_id: envelope.challenge_id,
      }),
    ).toString('base64');
    const r = await fetch(`${API}/v3/loop/agents/${AGENT}/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-wallet-address': BUYER, 'X-PAYMENT': xPayment },
      body: JSON.stringify({ buyer_address: BUYER, payment_coin_object_id: COIN }),
    });
    const body = (await r.json()) as { code?: string };
    if (r.status !== 402 || body.code !== 'replay_or_tamper') {
      throw new Error(`expected 402 replay_or_tamper, got ${r.status} ${JSON.stringify(body)}`);
    }
  });

  await step('Wrong payer → 402 bad_payer', async () => {
    if (!envelope) throw new Error('no envelope');
    const xPayment = Buffer.from(
      JSON.stringify({
        ptb_bytes_b64: envelope.ptb_bytes_b64,
        buyer_signature: 'AAAA',
        challenge_id: envelope.challenge_id,
      }),
    ).toString('base64');
    const otherBuyer = '0x' + 'b'.repeat(64);
    const r = await fetch(`${API}/v3/loop/agents/${AGENT}/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-wallet-address': otherBuyer, 'X-PAYMENT': xPayment },
      body: JSON.stringify({ buyer_address: otherBuyer, payment_coin_object_id: COIN }),
    });
    const body = (await r.json()) as { code?: string };
    if (r.status !== 402 || body.code !== 'bad_payer') {
      throw new Error(`expected 402 bad_payer, got ${r.status} ${JSON.stringify(body)}`);
    }
  });

  console.log('\n✅ smoke-loop-x402 passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
