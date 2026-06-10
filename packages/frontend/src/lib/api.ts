/**
 * lib/api.ts — single boundary between the frontend and the OpenX API.
 *
 * SOLID:
 *  - SRP: this file owns "where the API is" + the public listing shape.
 *    Pages depend on these typed accessors; no page hard-codes URL strings.
 *  - DIP: callers depend on the named exports, never on `process.env.*`.
 *  - OCP: a new endpoint = one helper here, no other change.
 */

export const AGENT_BACKEND_URL =
  process.env.NEXT_PUBLIC_AGENT_BACKEND_URL ?? 'http://localhost:3001';

/** A row from `GET /v3/marketplace/listings`. */
export interface Listing {
  id: string;
  brain_id: number | string;
  slug: string;
  chain: string;
  domain: string | null;
  short_description: string | null;
  verification_tier: 'basic' | 'verified' | 'tee_attested';
  pricing: { x402?: string | null; mpp?: string | null; sui_usdc?: string | null };
  persona: { system_prompt?: string | null; tools?: string[] } | null;
  created_at: string;
  title: string;
  description: string | null;
  tags: string[] | null;
}

/** A row from `GET /v3/memory/marketplace`. */
export interface MemWalBrain {
  sui_object_id: string;
  seller_wallet: string;
  memwal_account_id: string;
  namespace: string;
  title: string;
  description?: string;
  price_per_query_usdc: string;
  kya_required: boolean;
  attestation_required: number;
  cognitive_level: number;
  sovereignty_proof_url?: string;
  created_at: string;
}

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${AGENT_BACKEND_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json() as Promise<T>;
}

/**
 * Send an authenticated mutation. The Sui address is the only auth credential —
 * passed verbatim as `x-wallet-address`. SOLID-DIP: pages depend on this
 * function, never on the header name string.
 */
async function authedJson<T>(
  method: 'POST' | 'PATCH',
  path: string,
  wallet: string,
  body: unknown,
): Promise<T> {
  const r = await fetch(`${AGENT_BACKEND_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-wallet-address': wallet,
      'x-chain': 'sui',
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await r.text();
  let data: unknown;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
  if (!r.ok) {
    const err = data as { error?: string; message?: string };
    throw new Error(err?.message ?? err?.error ?? `${r.status}`);
  }
  return data as T;
}

export interface SellerProfile {
  id: number;
  wallet_address: string;
  display_name: string | null;
  bio: string | null;
  contact_email: string | null;
  support_url: string | null;
}

export interface SellerDashboard {
  seller_id: number | null;
  agents: Array<{
    id: string;
    slug: string;
    domain: string;
    verification_tier: string;
    created_at: string;
    earned_total: string;
    calls_total: number;
  }>;
  earnings: { last_7d: string; last_30d: string; all_time: string; calls_7d: number };
}

export interface PublishInput {
  title: string;
  short_description: string;
  long_description?: string;
  domain: 'marketing' | 'finance' | 'research' | 'engineering' | 'generalist' | 'other';
  tags?: string[];
  persona_system_prompt: string;
  pricing_amount_usdc: string;
  pricing_rails?: Array<'sui_usdc' | 'x402' | 'mpp'>;
  chain?: 'sui-testnet' | 'sui-mainnet';
}

export interface PublishResult {
  agent_id: string;
  brain_id: number;
  slug: string;
  listing_url: string;
  knowledge_url: string;
  manifest_yaml: string;
}

export const api = {
  listings: () =>
    getJson<{ listings: Listing[] }>('/v3/marketplace/listings').then((r) => r.listings),
  memwalBrains: () =>
    getJson<{ brains: MemWalBrain[] }>('/v3/memory/marketplace').then((r) => r.brains),
  listing: async (slugOrId: string): Promise<Listing | null> => {
    const all = await getJson<{ listings: Listing[] }>('/v3/marketplace/listings').then(
      (r) => r.listings,
    );
    return (
      all.find((l) => l.slug === slugOrId || String(l.brain_id) === slugOrId || l.id === slugOrId) ??
      null
    );
  },

  // ─── Seller surface ────────────────────────────────────────────────────
  sellerMe: (wallet: string) =>
    fetch(`${AGENT_BACKEND_URL}/v3/marketplace/seller/me`, {
      headers: { 'x-wallet-address': wallet },
    }).then((r) => r.json() as Promise<{ seller: SellerProfile | null }>),
  sellerDashboard: (wallet: string) =>
    fetch(`${AGENT_BACKEND_URL}/v3/marketplace/seller/dashboard`, {
      headers: { 'x-wallet-address': wallet },
    }).then((r) => r.json() as Promise<SellerDashboard>),
  updateSellerProfile: (wallet: string, patch: Partial<Omit<SellerProfile, 'id' | 'wallet_address'>>) =>
    authedJson<{ ok: true }>('PATCH', '/v3/marketplace/seller/me', wallet, patch),
  publish: (wallet: string, input: PublishInput) =>
    authedJson<PublishResult>('POST', '/v3/marketplace/seller/publish', wallet, {
      pricing_rails: ['sui_usdc'],
      chain: 'sui-testnet',
      ...input,
    }),

  // ─── MemWal training surface ──────────────────────────────────────────
  memwalAccount: (wallet: string) =>
    fetch(`${AGENT_BACKEND_URL}/v3/memory/account`, {
      headers: { 'x-wallet-address': wallet },
    }).then((r) => r.json() as Promise<{ accountId: string | null; wallet: string }>),
  memwalRemember: (wallet: string, text: string, namespace?: string) =>
    authedJson<{ ok: true; blob_id: string | null; job_id: string | null; mode?: string }>(
      'POST',
      '/v3/memory/remember',
      wallet,
      { text, namespace },
    ),
  memwalOperatorStats: (wallet: string) =>
    fetch(`${AGENT_BACKEND_URL}/v3/memory/operator/stats`, {
      headers: { 'x-wallet-address': wallet },
    }).then((r) => r.json()),
};

/** Best price across rails — UI display only; server is authoritative. */
export function priceFromPricing(p: Listing['pricing'] | undefined): { rail: string; amount: string } | null {
  if (!p) return null;
  for (const k of ['sui_usdc', 'x402', 'mpp'] as const) {
    if (p[k]) return { rail: k, amount: p[k]! };
  }
  return null;
}
