/**
 * suiX402Core.ts — shared primitives for Sui-native x402 paywalls.
 *
 * Two paywall middlewares share this surface:
 *   - `loopX402.ts` — Loop jobs (Mode A x402), keyed by Loop Agent shared object id
 *   - `agentX402.ts` — per-query agent paywall, keyed by `agents.slug`
 *
 * Both need the same plumbing: HMAC challenge envelope, sponsor co-sign,
 * gas-coin pick, executeTransactionBlock, settlement-event extraction.
 * This module owns ALL of that. The paywall files map their domain inputs
 * (slug → row, jobId → row) onto the same primitive calls.
 *
 * SOLID:
 *   - SRP: HMAC + sponsor + gas + execute. Zero domain knowledge of agents,
 *     brains, jobs, slugs, prices, or rails.
 *   - DIP: SuiClient + sponsor keypair are lazy singletons; tests can swap
 *     via `setTestOverrides` (covered in smoke tests).
 *   - OCP: a third paywall (e.g. bundle) plugs in by importing from here;
 *     no edits required to this file.
 *
 * Mistake-avoidance: never throws on configuration; returns a typed error
 * envelope so callers can return a 402 with a stable `code` field the
 * buyer client can react to (`bad_sig`, `expired`, `replay_or_tamper`,
 * `on_chain`, `submit_failed`).
 */

import crypto from 'node:crypto';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';

// ─── Env-derived module config ───────────────────────────────────────────

const RPC_URL = process.env.SUI_RPC_URL ?? getFullnodeUrl('testnet');
const SPONSOR_KEY =
  process.env.OPENX_LOOP_SPONSOR_PRIVATE_KEY ?? process.env.OPENX_OPERATOR_SUI_PRIVATE_KEY ?? '';
const HMAC_SECRET = process.env.PAYMENT_SECRET ?? 'dev-only-payment-secret-please-rotate';

export const NETWORK: 'sui-testnet' | 'sui-mainnet' =
  (process.env.SUI_NETWORK as 'sui-testnet' | 'sui-mainnet') ?? 'sui-testnet';

// ─── Lazy singletons ─────────────────────────────────────────────────────

let _client: SuiClient | null = null;
let _sponsor: Ed25519Keypair | null = null;

export function getSuiClient(): SuiClient {
  return (_client ??= new SuiClient({ url: RPC_URL }));
}

export function getSponsor(): Ed25519Keypair {
  if (_sponsor) return _sponsor;
  if (!SPONSOR_KEY) throw new Error('suiX402Core: OPENX_LOOP_SPONSOR_PRIVATE_KEY missing');
  const { schema, secretKey } = decodeSuiPrivateKey(SPONSOR_KEY);
  if (schema !== 'ED25519') throw new Error(`suiX402Core: sponsor key must be ED25519, got ${schema}`);
  _sponsor = Ed25519Keypair.fromSecretKey(secretKey);
  return _sponsor;
}

/** Test hook — swap in mock client + sponsor without touching globals. */
export function setTestOverrides(c: { client?: SuiClient; sponsor?: Ed25519Keypair }): void {
  if (c.client) _client = c.client;
  if (c.sponsor) _sponsor = c.sponsor;
}

// ─── HMAC challenge envelope (replay defence) ────────────────────────────

export interface ChallengeBody {
  /** Domain id — agent slug for agent paywall, agent_object_id for loop. */
  resource: string;
  amount: string;
  payer: string;
  ptb_digest_hex: string;
  expires_at_ms: number;
}

const CHALLENGE_TTL_MS = 5 * 60_000;

export function signChallenge(body: ChallengeBody): string {
  const c = JSON.stringify(body);
  const sig = crypto.createHmac('sha256', HMAC_SECRET).update(c).digest('base64url');
  return `${Buffer.from(c).toString('base64url')}.${sig}`;
}

export function verifyChallenge(token: string): ChallengeBody | null {
  try {
    const [bodyB64, sig] = token.split('.');
    if (!bodyB64 || !sig) return null;
    const expected = crypto
      .createHmac('sha256', HMAC_SECRET)
      .update(Buffer.from(bodyB64, 'base64url'))
      .digest('base64url');
    if (sig !== expected) return null;
    const body: ChallengeBody = JSON.parse(Buffer.from(bodyB64, 'base64url').toString('utf8'));
    if (body.expires_at_ms < Date.now()) return null;
    return body;
  } catch {
    return null;
  }
}

export function buildChallenge(b: Omit<ChallengeBody, 'expires_at_ms'>): {
  body: ChallengeBody;
  token: string;
} {
  const body: ChallengeBody = { ...b, expires_at_ms: Date.now() + CHALLENGE_TTL_MS };
  return { body, token: signChallenge(body) };
}

export function digestPtb(ptbBytes: Uint8Array | Buffer): string {
  return crypto.createHash('sha256').update(ptbBytes).digest('hex');
}

// ─── Sponsored-tx helpers ────────────────────────────────────────────────

export interface SponsoredGasCoin {
  objectId: string;
  version: string;
  digest: string;
}

/** Pick one SUI coin from the sponsor wallet for gas. Returns null if empty. */
export async function pickSponsorGasCoin(): Promise<SponsoredGasCoin | null> {
  const owner = getSponsor().toSuiAddress();
  const coins = await getSuiClient().getCoins({ owner, coinType: '0x2::sui::SUI', limit: 1 });
  const c = coins.data[0];
  if (!c) return null;
  return { objectId: c.coinObjectId, version: c.version, digest: c.digest };
}

/**
 * Finalize a buyer-built PTB into sponsored-tx bytes. Caller pre-fills the
 * Move/transfer commands; we set sender/gas-owner/gas-payment and build.
 *
 * Returns base64 PTB bytes + the sha256 digest used by the HMAC challenge.
 */
export async function finalizeSponsoredPtb(args: {
  tx: Transaction;
  buyerAddress: string;
}): Promise<{ ptbBytesB64: string; ptbDigestHex: string; gas: SponsoredGasCoin }> {
  const sponsor = getSponsor();
  const gas = await pickSponsorGasCoin();
  if (!gas) throw new SuiX402Error('sponsor_gas_empty', 'sponsor wallet has no SUI');
  args.tx.setSender(args.buyerAddress);
  args.tx.setGasOwner(sponsor.toSuiAddress());
  args.tx.setGasPayment([gas]);
  const ptbBytes = await args.tx.build({ client: getSuiClient() });
  return {
    ptbBytesB64: Buffer.from(ptbBytes).toString('base64'),
    ptbDigestHex: digestPtb(ptbBytes),
    gas,
  };
}

/**
 * Co-sign + submit. Returns the on-chain digest on success; throws
 * `SuiX402Error` on submit/effects failure so the caller can map to 402.
 */
export async function executeWithSponsor(args: {
  ptbBytesB64: string;
  buyerSignature: string;
}): Promise<{ digest: string; events: Array<Record<string, unknown>> }> {
  const ptbBytes = Buffer.from(args.ptbBytesB64, 'base64');
  const sponsorSig = (await getSponsor().signTransaction(ptbBytes)).signature;

  let r;
  try {
    r = await getSuiClient().executeTransactionBlock({
      transactionBlock: ptbBytes,
      signature: [args.buyerSignature, sponsorSig],
      options: { showEvents: true, showEffects: true },
    });
  } catch (e) {
    throw new SuiX402Error('submit_failed', String((e as Error).message ?? e));
  }
  if (r.effects?.status?.status !== 'success') {
    throw new SuiX402Error('on_chain_failed', r.effects?.status?.error ?? 'unknown');
  }
  const events = (r.events ?? []).map((e) => ({
    type: e.type,
    parsedJson: e.parsedJson,
  })) as Array<Record<string, unknown>>;
  return { digest: r.digest, events };
}

// ─── Typed error so route handlers can map to a stable 402 envelope ─────

export type SuiX402Code =
  | 'bad_sig'
  | 'expired_or_forged'
  | 'bad_payer'
  | 'bad_resource'
  | 'replay_or_tamper'
  | 'on_chain_failed'
  | 'submit_failed'
  | 'sponsor_gas_empty'
  | 'parse_error';

export class SuiX402Error extends Error {
  constructor(public code: SuiX402Code, public detail?: string) {
    super(`${code}${detail ? `: ${detail}` : ''}`);
    this.name = 'SuiX402Error';
  }
}

/**
 * Verify a buyer-submitted X-PAYMENT envelope against an HMAC challenge.
 * Returns the parsed body; throws SuiX402Error on any mismatch.
 *
 * Caller passes `expected.resource` (slug or agent-id) + `expected.payer`
 * (lower-cased buyer address). We do NOT trust the body for these — they
 * have to match what the route handler already loaded from the DB / header.
 */
export function parseAndVerifyXPayment(
  xPayment: string,
  expected: { resource: string; payer: string },
): { ptbBytesB64: string; buyerSignature: string; challenge: ChallengeBody } {
  let parsed: { ptb_bytes_b64: string; buyer_signature: string; challenge_id: string };
  try {
    parsed = JSON.parse(Buffer.from(xPayment, 'base64').toString('utf8'));
  } catch {
    throw new SuiX402Error('parse_error', 'X-PAYMENT is not base64-JSON');
  }
  const ch = verifyChallenge(parsed.challenge_id);
  if (!ch) throw new SuiX402Error('expired_or_forged');
  if (ch.payer !== expected.payer) throw new SuiX402Error('bad_payer');
  if (ch.resource !== expected.resource) throw new SuiX402Error('bad_resource');
  const incomingDigest = digestPtb(Buffer.from(parsed.ptb_bytes_b64, 'base64'));
  if (ch.ptb_digest_hex !== incomingDigest) throw new SuiX402Error('replay_or_tamper');
  return {
    ptbBytesB64: parsed.ptb_bytes_b64,
    buyerSignature: parsed.buyer_signature,
    challenge: ch,
  };
}
