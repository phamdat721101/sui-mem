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

export interface TrainingEvent {
  event_type: 'upload' | 'remember' | 'reflect' | 'settle';
  walrus_blob_id: string | null;
  sui_tx_digest: string | null;
  namespace: string | null;
  summary: string | null;
  created_at: string;
  explorer_urls: { walrus: string | null; sui: string | null };
}

// ─── Agent config (post-publish edits) ────────────────────────────────
// SOLID: shapes mirror the backend AgentEditableRow (single source of truth
// in v3-marketplace.ts). `null` is "field unset"; `undefined` in a patch is
// "leave alone".
export interface EditableAgent {
  id: string;
  slug: string;
  brain_id: number;
  owner_address: string;
  title: string | null;
  short_description: string | null;
  long_description: string | null;
  domain: PublishInput['domain'] | null;
  verification_tier: 'basic' | 'verified' | 'tee_attested' | null;
  tags: string[] | null;
  persona: { system_prompt?: string | null; tools?: string[] | null } | null;
  pricing: { x402?: string | null; mpp?: string | null; sui_usdc?: string | null } | null;
  daily_request_cap: number | null;
  chain: string;
}

export interface EditableAgentPatch {
  title: string;
  short_description: string;
  long_description: string | null;
  domain: PublishInput['domain'];
  verification_tier: 'basic' | 'verified' | 'tee_attested';
  tags: string[];
  persona: { system_prompt?: string; tools?: string[] };
  pricing: { x402?: string | null; mpp?: string | null; sui_usdc?: string | null };
  daily_request_cap: number | null;
}

export interface AgentPaymentInfo {
  slug: string;
  payee_address: string;
  price_usdc: string | null;
  asset_coin_type: string | null;
  chain: 'sui';
  network: string;
  paywall_url: string;
  public_url: string;
  /** Free /try calls per buyer per 24h. 0 = no free tier (paywall every call). */
  daily_request_cap: number;
  /** Sui address that receives the platform cut on every paid call. */
  platform_treasury: string | null;
  /** Platform cut in basis points (500 = 5%). */
  platform_bps: number;
}

export const api = {
  listings: () =>
    getJson<{ listings: Listing[] }>('/v3/marketplace/listings').then((r) => r.listings),
  memwalBrains: () =>
    getJson<{ brains: MemWalBrain[] }>('/v3/memory/marketplace').then((r) => r.brains),
  listing: async (slugOrId: string): Promise<Listing | null> => {
    // Single-slug endpoint avoids the "fetch all + find" anti-pattern that
    // turned every transient API blip into a false "agent not found".
    // 404 = real not-found (return null). Other failures throw so the UI
    // can render a retry button instead of misleading the user.
    const r = await fetch(
      `${AGENT_BACKEND_URL}/v3/marketplace/listings/${encodeURIComponent(slugOrId)}`,
      { headers: { 'Content-Type': 'application/json' }, cache: 'no-store' },
    );
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    const j = (await r.json()) as { listing: Listing };
    return j.listing;
  },

  // ─── Agent workspace (PRD-E port) ─────────────────────────────────────
  /**
   * Mint a Walrus publisher URL + size cap. Step 1 of the upload flow.
   * The browser then PUTs the file bytes directly to the publisher
   * (no proxy through the API).
   */
  mintAgentUpload: (slug: string, file: { original_name: string; mime_type: string; size_bytes: number }) =>
    getJson<{ publisher_url: string; aggregator_url: string; max_bytes: number; ttl_sec: number }>(
      `/v3/agents/${encodeURIComponent(slug)}/uploads/mint`,
      { method: 'POST', body: JSON.stringify(file) },
    ),

  /**
   * Step 2: PUT raw bytes to the Walrus publisher. Returns the blobId.
   * This lives client-side; bytes never traverse the OpenX API.
   */
  uploadFileToWalrus: async (publisherUrl: string, file: File): Promise<string> => {
    const res = await fetch(`${publisherUrl}/v1/blobs?epochs=1`, { method: 'PUT', body: file });
    if (!res.ok) throw new Error(`walrus publisher ${res.status}`);
    const j = (await res.json()) as {
      newlyCreated?: { blobObject?: { blobId?: string } };
      alreadyCertified?: { blobId?: string };
    };
    const blobId = j.newlyCreated?.blobObject?.blobId ?? j.alreadyCertified?.blobId;
    if (!blobId) throw new Error('walrus publisher returned no blobId');
    return blobId;
  },

  /**
   * Step 3: record the blob_id with the API so the server can attach the
   * upload to a future /try call. PDF rows are extracted synchronously
   * here — the response includes `extraction_status` so the UI can show
   * "PDF parsed" / "PDF is image-only — referenced by URL only" etc.
   */
  confirmAgentUpload: (slug: string, body: {
    blob_id: string; original_name: string; mime_type: string; size_bytes: number;
    payer_address?: string;
  }) =>
    getJson<{ upload_id: string; expires_at: string; extraction_status: string }>(
      `/v3/agents/${encodeURIComponent(slug)}/uploads`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  /** Free `/try` — no payment_coin_object_id; rate-limited 5/day per IP. */
  tryAgentFree: (slug: string, body: { question: string; upload_ids?: string[] }) =>
    getJson<{
      answer: string;
      citations: Array<{ source?: string; snippet: string }>;
      attestation: { provider: string; quote: string; verified: boolean; issuedAt: string };
      settled: null;
    }>(`/v3/agents/${encodeURIComponent(slug)}/try`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** Anonymized public ledger for the recent-calls feed. */
  getAgentRecentCalls: (slug: string, limit = 10) =>
    getJson<{
      rows: Array<{
        tx_hash: string; payer: string; amount_usdc: string;
        method: string; network: string; settled_at: string;
      }>;
      cached: boolean;
    }>(`/v3/agents/${encodeURIComponent(slug)}/recent-calls?limit=${limit}`),

  /** AgentCard for AI-buyer integration (the same JSON Cursor / Claude reads). */
  getAgentCard: (slug: string) =>
    getJson<{
      name: string; description: string; url: string; payTo: string; chain: string;
      asset: string | null;
      tools: Array<{ name: string; description: string; price: string; currency: 'USDC' }>;
      system_prompt: string | null;
    }>(`/api/v1/${encodeURIComponent(slug)}/.well-known/agent.json`),

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

  // ─── Per-agent training (PRD-F) ────────────────────────────────────────
  getAgentTrainingEvents: (wallet: string, slug: string, limit = 50) =>
    fetch(
      `${AGENT_BACKEND_URL}/v3/marketplace/seller/agents/${encodeURIComponent(slug)}/events?limit=${limit}`,
      { headers: { 'x-wallet-address': wallet }, cache: 'no-store' },
    ).then(async (r) => {
      if (r.status === 404) return { events: [] as TrainingEvent[], notOwner: true };
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const j = (await r.json()) as { events: TrainingEvent[] };
      return { events: j.events, notOwner: false };
    }),
  sellerAgentUploadConfirm: (wallet: string, slug: string, body: {
    walrus_blob_id: string; original_name: string; mime_type: string; size_bytes: number;
  }) =>
    authedJson<{ id: string; created_at: string }>(
      'POST', `/v3/marketplace/seller/agents/${encodeURIComponent(slug)}/upload`, wallet, body,
    ),
  sellerAgentRemember: (wallet: string, slug: string, text: string, level: 2 | 3 | 4 = 3) =>
    authedJson<{ id: string; walrus_blob_id: string | null; namespace: string; mode: string | null; created_at: string }>(
      'POST', `/v3/marketplace/seller/agents/${encodeURIComponent(slug)}/remember`, wallet,
      { text, level },
    ),
  sellerAgentTrainingLoop: (wallet: string, slug: string) =>
    authedJson<{ id: string; walrus_blob_id: string | null; namespace: string; critique: string; created_at: string }>(
      'POST', `/v3/marketplace/seller/agents/${encodeURIComponent(slug)}/training-loop`, wallet, {},
    ),

  // ─── Agent config (post-publish edits) ────────────────────────────────
  // SOLID: thin authedJson wrappers; the backend in v3-marketplace.ts owns
  // every validation rule. The config page is purely a form over these.
  getOwnedAgent: (wallet: string, slug: string) =>
    fetch(`${AGENT_BACKEND_URL}/v3/marketplace/seller/agents/${encodeURIComponent(slug)}`, {
      headers: { 'x-wallet-address': wallet },
      cache: 'no-store',
    }).then(async (r) => {
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const j = (await r.json()) as { agent: EditableAgent };
      return j.agent;
    }),
  updateAgent: (wallet: string, slug: string, patch: Partial<EditableAgentPatch>) =>
    authedJson<{ agent: EditableAgent }>(
      'PATCH', `/v3/marketplace/seller/agents/${encodeURIComponent(slug)}`, wallet, patch,
    ),
  agentPaymentInfo: (slug: string) =>
    fetch(`${AGENT_BACKEND_URL}/v3/marketplace/agents/${encodeURIComponent(slug)}/payment-info`, {
      cache: 'no-store',
    }).then(async (r) => {
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      return r.json() as Promise<AgentPaymentInfo>;
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
