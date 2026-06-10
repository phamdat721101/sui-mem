import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes } from '@noble/hashes/utils';

/** Constant-time byte-array equality — replaces Node's `timingSafeEqual`. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Resume tokens — opaque, HMAC-signed payloads that let a client retry a
 * long-running operation without re-doing the work that already succeeded.
 *
 * Runtime-neutral: `node:crypto` works in Node and modern Edge runtimes.
 *
 * SOLID:
 * - Single Responsibility: sign / verify / decode. No business logic.
 * - Liskov: every consumer (uploads, migrations) treats the token the same way.
 *
 * Mistake-avoidance: this is the *only* HMAC entry point. Other modules MUST go
 * through `signResumeToken` / `verifyResumeToken`, never roll their own.
 */

interface InternalEnvelope<T> {
  v: 1;
  iat: string;
  data: T;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000;

export interface ResumeTokenOptions {
  /** Symmetric secret. Must be ≥16 chars. Default: process.env.RESUME_TOKEN_SECRET. */
  secret?: string;
  /** TTL in ms. Default 24h. */
  ttlMs?: number;
}

function resolveSecret(secret?: string): string {
  const s = secret ?? process.env.RESUME_TOKEN_SECRET;
  if (!s || s.length < 16) {
    throw new Error('resume token secret must be set to a >=16 char value');
  }
  return s;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

/** Sign a typed payload, returning a single-string token. */
export function signResumeToken<T>(data: T, opts: ResumeTokenOptions = {}): string {
  const env: InternalEnvelope<T> = { v: 1, iat: new Date().toISOString(), data };
  const body = b64url(Buffer.from(JSON.stringify(env)));
  const sigBytes = hmac(sha256, utf8ToBytes(resolveSecret(opts.secret)), utf8ToBytes(body));
  const sig = b64url(Buffer.from(sigBytes));
  return `${body}.${sig}`;
}

export class InvalidResumeToken extends Error {
  constructor(reason: string) {
    super(`invalid resume token: ${reason}`);
    this.name = 'InvalidResumeToken';
  }
}

/** Verify a token; throws `InvalidResumeToken` on tamper / malformed / expired. */
export function verifyResumeToken<T>(token: string, opts: ResumeTokenOptions = {}): T {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const parts = token.split('.');
  if (parts.length !== 2) throw new InvalidResumeToken('shape');

  const [body, sig] = parts;
  const expected = hmac(sha256, utf8ToBytes(resolveSecret(opts.secret)), utf8ToBytes(body));
  const got = new Uint8Array(fromB64url(sig));
  if (!constantTimeEqual(got, expected)) {
    throw new InvalidResumeToken('signature');
  }

  let env: InternalEnvelope<T>;
  try {
    env = JSON.parse(fromB64url(body).toString('utf8')) as InternalEnvelope<T>;
  } catch {
    throw new InvalidResumeToken('json');
  }

  if (env.v !== 1) throw new InvalidResumeToken('version');
  if (Date.now() - new Date(env.iat).getTime() > ttlMs) throw new InvalidResumeToken('expired');
  return env.data;
}
