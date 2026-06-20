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

const WALRUS_AGGREGATOR =
  process.env.NEXT_PUBLIC_WALRUS_AGGREGATOR_URL ?? 'https://aggregator.walrus-testnet.walrus.space';

/** Synthetic `tx_hash` prefixes used by the backend for non-on-chain rows
 *  (subscription cron forks, in-modal Run-Now demos). The FE must NEVER
 *  construct an explorer URL for these — Suiscan will 404. */
const SYNTHETIC_TX_PREFIXES = ['demo:', 'cron:', 'runnow:'];

/** Sentinel blob ids the FE has staged before a real Walrus pin exists.
 *  Treat as "no link" rather than rendering a 404 download. */
const PLACEHOLDER_BLOB_PREFIXES = ['pending-', 'stub-'];

/** True when the blob_id is a sentinel placeholder, not a real Walrus id. */
export function isPlaceholderBlob(blob_id: string | null | undefined): boolean {
  if (!blob_id) return true;
  return PLACEHOLDER_BLOB_PREFIXES.some((p) => blob_id.startsWith(p));
}

/** Build a public Walrus aggregator URL, or null if the blob is a placeholder.
 *  Walrus testnet aggregator path is `/v1/blobs/{id}` — NOT `/v1/{id}`. */
export function walrusViewUrl(blob_id: string | null | undefined): string | null {
  if (isPlaceholderBlob(blob_id)) return null;
  return `${WALRUS_AGGREGATOR}/v1/blobs/${blob_id}`;
}

/**
 * Trigger a browser file download for an in-memory `Blob`. SSR-safe: no-op
 * on the server. Single source of truth so vault + run-result downloads
 * never reimplement the `<a download>` dance.
 */
export function triggerDownload(blob: Blob, filename: string): void {
  if (typeof window === 'undefined') return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Defer revoke so Chrome/Firefox have time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/**
 * Authed download of a buyer-vault blob via the API proxy
 * (`/v3/loop/buyer/vault/blob/:blob_id`). Bypasses every browser-direct
 * Walrus failure mode (aggregator CORS / rate-limit / placeholder ids /
 * inline-render surprises) by streaming server-side bytes through the API.
 *
 * Throws on any non-OK response so the caller can surface the error.
 */
export async function vaultDownload(
  wallet: string,
  blob_id: string,
  fallbackName?: string,
): Promise<void> {
  const r = await fetch(
    `${AGENT_BACKEND_URL}/v3/loop/buyer/vault/blob/${encodeURIComponent(blob_id)}`,
    { headers: { 'x-wallet-address': wallet } },
  );
  if (!r.ok) {
    const j = await r.json().catch(() => ({} as { error?: string }));
    throw new Error(j.error ?? `download ${r.status}`);
  }
  // Prefer server-supplied filename; fall back to the caller hint.
  const cd = r.headers.get('content-disposition') ?? '';
  const m = /filename="([^"]+)"/.exec(cd);
  const name = m?.[1] || fallbackName || `${blob_id}.bin`;
  triggerDownload(await r.blob(), name);
}

/** Build a Suiscan tx URL, or null when the tx_hash is synthetic (cron forks,
 *  Run-Now demos) or the network isn't a real Sui network. */
export function explorerTxUrl(network: string | null | undefined, tx_hash: string | null | undefined): string | null {
  if (!tx_hash || !network) return null;
  if (SYNTHETIC_TX_PREFIXES.some((p) => tx_hash.startsWith(p))) return null;
  if (network === 'sui-testnet') return `https://suiscan.xyz/testnet/tx/${tx_hash}`;
  if (network === 'sui-mainnet') return `https://suiscan.xyz/mainnet/tx/${tx_hash}`;
  return null;
}

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
  /**
   * On-chain `Agent` shared object id, resolved server-side via the
   * indexer's first `LoopAgentPublished` event for this row's
   * `fee_tx_digest`. `null` ⇒ off-chain only (no escrow possible — the
   * Hire button must surface the gap, not let the buyer hit a confusing
   * `agent_not_found_or_unpublished` 404 mid-flow).
   */
  agent_object_id: string | null;
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

/** A single artifact within a run group. */
export interface RunArtifact {
  job_id: string;
  area_slug: string | null;
  artifact_name: string;
  walrus_blob_id: string;
  mime_type: string;
  created_at: string;
}

/** Per-run timeline status. Mirrors the BE view's CASE expression. */
export type RunStatus = 'pending' | 'running' | 'success' | 'failed' | 'completed';

/** A workflow run + its artifacts — the timeline UI's grouping unit. */
export interface RunGroup {
  job_id: string;
  area_slug: string | null;
  agent_id: string | null;
  run_started_at: string | null;
  run_completed_at: string | null;
  outcome_satisfied: boolean | null;
  total_cost_micro: number | null;
  step_count: number | null;
  workflow_walrus_blob_id: string | null;
  run_status: RunStatus;
  artifacts: RunArtifact[];
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
    /** Same on-chain readiness signal as Listing.agent_object_id. */
    agent_object_id: string | null;
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
  /**
   * Returns a fully-shaped `SellerDashboard` for *every* wallet — including
   * newly-connected wallets that have no `seller` row yet (backend returns
   * 401/404). Mirrors the defensive contract of `getSellerOnChainStats` /
   * `getSellerWalletEvents` so consumers can dereference `.agents.length`
   * and `.earnings.all_time` without optional chaining.
   *
   * Crash this previously caused: /settings rendered `dash.agents.length`
   * inside `{dash && …}`. When the cast lied (`dash = {}`), React threw
   * during render and unmounted the whole client tree → blank page.
   */
  sellerDashboard: async (wallet: string): Promise<SellerDashboard> => {
    const empty: SellerDashboard = {
      seller_id: null,
      agents: [],
      earnings: { last_7d: '0', last_30d: '0', all_time: '0', calls_7d: 0 },
    };
    try {
      const r = await fetch(`${AGENT_BACKEND_URL}/v3/marketplace/seller/dashboard`, {
        headers: { 'x-wallet-address': wallet },
        cache: 'no-store',
      });
      if (r.status === 404 || r.status === 401) return empty;
      if (!r.ok) throw new Error(`sellerDashboard ${r.status}`);
      const j = (await r.json()) as Partial<SellerDashboard>;
      return {
        seller_id: j.seller_id ?? null,
        agents: Array.isArray(j.agents) ? j.agents : [],
        earnings: {
          last_7d: j.earnings?.last_7d ?? '0',
          last_30d: j.earnings?.last_30d ?? '0',
          all_time: j.earnings?.all_time ?? '0',
          calls_7d: j.earnings?.calls_7d ?? 0,
        },
      };
    } catch {
      return empty;
    }
  },
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

  // ─── PRD-W v1.1 — upgrade wizard + daily-run + buyer surfaces ────────
  upgradePreview: (wallet: string, agentObjectId: string) =>
    fetch(`${AGENT_BACKEND_URL}/v3/loop/seller/agents/${encodeURIComponent(agentObjectId)}/upgrade-preview`, {
      headers: { 'x-wallet-address': wallet },
      cache: 'no-store',
    }).then(async (r) => {
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json() as Promise<{
        distribution: Record<'project' | 'area' | 'resource' | 'archive', number>;
        sample: Array<{
          id: number; namespace: string;
          predicted: { para_kind: string; area_slug: string | null };
          created_at: string;
        }>;
      }>;
    }),
  upgradeAgent: (
    wallet: string,
    agentObjectId: string,
    body: { workflow_walrus_blob_id: string; stop_condition_walrus_blob_id?: string; area_slugs: string[] },
  ) =>
    authedJson<{ ok: true; declared_areas: number; pending_chain_ptb: { kind: string } }>(
      'POST',
      `/v3/loop/seller/agents/${encodeURIComponent(agentObjectId)}/upgrade`,
      wallet,
      body,
    ),

  listSubscriptions: (wallet: string) =>
    fetch(`${AGENT_BACKEND_URL}/v3/loop/subscriptions`, {
      headers: { 'x-wallet-address': wallet },
      cache: 'no-store',
    }).then(async (r) => {
      if (!r.ok) return { subscriptions: [] };
      return r.json() as Promise<{
        subscriptions: Array<{
          subscription_object_id: string; agent_id: string;
          area_slug: string | null; cron_utc_minute: number;
          runs_remaining: number; max_per_run_micro: number;
          next_run_ts: number; last_run_ts: number | null;
          cancelled_at: string | null;
          // v2 escrow fields. Older API responses omit them — the FE
          // narrows on undefined to keep backward compat with v1 rows.
          escrow_remaining_micro?: string;
          total_escrowed_micro?: string;
          package_version?: number;
          status?: 'active' | 'stopped' | 'cancelled' | 'exhausted';
        }>;
      }>;
    }),

  /**
   * v2 escrow create — backend returns a buyer-signable PTB envelope. The FE
   * signs + executes via dapp-kit, then calls `confirmSubscription` so
   * /activity reflects the new hire instantly (indexer would otherwise
   * lag by one event sweep).
   *
   * Echoes the resolved on-chain `agent_object_id` so the FE never needs to
   * know whether it sent a slug or a real Sui id — the canonical id flows
   * back from the API and is stored in `loop_subscriptions.agent_id`.
   */
  buildCreateEscrowPtb: (wallet: string, body: {
    agent_object_id: string; template_walrus_blob_id: string;
    area_slug?: string; cron_utc_minute: number; runs: number;
    max_per_run_micro: number; budget_coin_object_id: string;
  }) =>
    authedJson<{
      ok: true; ptb_bytes_b64: string; total_escrow_micro: string;
      package_version: 2; agent_object_id: string;
    }>(
      'POST', '/v3/loop/subscriptions', wallet, body,
    ),

  /**
   * Idempotent post-sign confirm. Pass the on-chain `WorkflowEscrow<T>`
   * shared object id derived from the signed-tx effects so the optimistic
   * row in /activity matches the real chain object.
   */
  confirmSubscription: (wallet: string, body: {
    subscription_object_id: string; agent_id: string;
    template_walrus_blob_id: string; area_slug?: string;
    cron_utc_minute: number; runs: number; max_per_run_micro: number;
    total_escrow_micro: string;
  }) =>
    authedJson<{ ok: true }>('POST', '/v3/loop/subscriptions/confirm', wallet, body),

  /** v2 escrow top-up PTB build. */
  buildTopUpPtb: (wallet: string, subscription_object_id: string, body: {
    runs_to_add: number; budget_coin_object_id: string;
  }) =>
    authedJson<{ ok: true; ptb_bytes_b64: string; added_micro: string }>(
      'POST', `/v3/loop/subscriptions/${encodeURIComponent(subscription_object_id)}/top-up`, wallet, body,
    ),

  /**
   * v2 escrow cancel — returns `{ ptb_bytes_b64 }` for v2 rows or `{ ok: true }`
   * for legacy v1 rows. The FE checks for `ptb_bytes_b64` and signs only when
   * present.
   */
  buildCancelSubscription: (wallet: string, subscription_object_id: string) =>
    authedJson<{ ok: true; ptb_bytes_b64?: string }>(
      'POST', `/v3/loop/subscriptions/${encodeURIComponent(subscription_object_id)}/cancel`, wallet, {},
    ),

  /** Seller view — per-subscription rows for the seller's ACTIVE_HIRES panel. */
  sellerAgentSubscribers: (wallet: string, agentSlugOrId: string) =>
    fetch(`${AGENT_BACKEND_URL}/v3/loop/seller/agents/${encodeURIComponent(agentSlugOrId)}/subscribers`, {
      headers: { 'x-wallet-address': wallet },
      cache: 'no-store',
    }).then(async (r) => {
      if (r.status === 404 || r.status === 403) return { subscribers: [] };
      if (!r.ok) throw new Error(`subscribers ${r.status}`);
      return r.json() as Promise<{
        subscribers: Array<{
          subscription_object_id: string; agent_id: string; buyer_addr: string;
          area_slug: string | null; cron_utc_minute: number;
          runs_remaining: number; max_per_run_micro: string;
          next_run_ts: string; last_run_ts: string | null;
          cancelled_at: string | null;
          escrow_remaining_micro: string; total_escrowed_micro: string;
          package_version: number; created_at: string;
          status: 'active' | 'stopped' | 'cancelled' | 'exhausted';
        }>;
      }>;
    }),

  vault: (wallet: string) =>
    fetch(`${AGENT_BACKEND_URL}/v3/loop/buyer/vault`, {
      headers: { 'x-wallet-address': wallet },
      cache: 'no-store',
    }).then((r) => r.json() as Promise<{
      entries: Array<{
        job_id: string; area_slug: string | null;
        artifact_name: string; walrus_blob_id: string;
        mime_type: string; created_at: string;
      }>;
    }>),

  // ─── PRD-W v1.2: per-run timeline + bundle ZIP + digest ────────────
  // SOLID: 3 thin helpers; the FE never hard-codes the URL shape.
  listRuns: (wallet: string, opts: { sinceDays?: number; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (opts.sinceDays) params.set('sinceDays', String(opts.sinceDays));
    if (opts.limit) params.set('limit', String(opts.limit));
    const q = params.toString();
    return fetch(
      `${AGENT_BACKEND_URL}/v3/loop/runs/by-buyer/${encodeURIComponent(wallet)}${q ? `?${q}` : ''}`,
      { headers: { 'x-wallet-address': wallet }, cache: 'no-store' },
    ).then(async (r) => {
      if (r.status === 404) return { runs: [] as RunGroup[] };
      if (!r.ok) throw new Error(`listRuns ${r.status}`);
      return r.json() as Promise<{ runs: RunGroup[] }>;
    });
  },

  bundleUrl: (job_id: string) =>
    `${AGENT_BACKEND_URL}/v3/loop/runs/${encodeURIComponent(job_id)}/bundle.zip`,

  getDigest: (wallet: string) =>
    fetch(`${AGENT_BACKEND_URL}/v3/loop/digests/by-buyer/${encodeURIComponent(wallet)}`, {
      headers: { 'x-wallet-address': wallet },
      cache: 'no-store',
    }).then((r) => r.json() as Promise<{
      digest: {
        week: string;
        artifact_name: string;
        walrus_blob_id: string;
        mime_type: string;
        created_at: string;
      } | null;
    }>),

  // Seller workflow YAML — view + edit (PRD-W v1.1 seller surface).
  getWorkflow: (wallet: string, agentObjectId: string) =>
    fetch(`${AGENT_BACKEND_URL}/v3/loop/seller/agents/${encodeURIComponent(agentObjectId)}/workflow`, {
      headers: { 'x-wallet-address': wallet },
      cache: 'no-store',
    }).then((r) => r.json() as Promise<{
      workflow: WorkflowYaml | null;
      updated_at?: string;
    }>),
  saveWorkflow: (wallet: string, agentObjectId: string, workflow: WorkflowYaml) =>
    authedJson<{ workflow: WorkflowYaml; updated_at: string }>(
      'PATCH',
      `/v3/loop/seller/agents/${encodeURIComponent(agentObjectId)}/workflow`,
      wallet,
      workflow,
    ),

  // Daily-run subscription PTB-build envelope (server returns intent until
  // the SDK builder lands; UI demos the shape today).
  subscribeWorkflow: (wallet: string, body: {
    agent_object_id: string; template_walrus_blob_id: string;
    area_slug?: string; cron_utc_minute: number; runs: number;
    max_per_run_micro: number; budget_coin_object_id: string;
  }) =>
    authedJson<{
      ok: true; deferred_until?: string;
      pending: Record<string, unknown>;
    }>('POST', '/v3/loop/subscriptions', wallet, body),

  // Right-to-forget — buyer-initiated 7d cooling-off delete of per-buyer slot.
  requestRtf: (wallet: string, agent_id: string, reason?: string) =>
    authedJson<{ request: { id: number; status: string }; cooling_off_days: number }>(
      'POST', '/v3/loop/buyer/right-to-forget', wallet, { agent_id, reason },
    ),

  // PRD-S — AI workflow synthesis (seller, owner-gated).
  synthesizeWorkflow: (
    wallet: string,
    slug: string,
    body: { description: string; category?: string },
  ) =>
    authedJson<{
      workflow: WorkflowYaml;
      reasoning: string;
      inferred_category: string;
    }>(
      'POST',
      `/v3/loop/seller/agents/${encodeURIComponent(slug)}/workflow/synthesize`,
      wallet,
      body,
    ),

  // PRD-S — buyer instant run (uses MockStepExecutor on the server).
  runWorkflowNow: (wallet: string, slug: string, body: { request: string }) =>
    authedJson<{
      steps_completed: number;
      steps_total: number;
      per_step: Array<{ id: string; phase: string; status: string; spent_micro: number; output: Record<string, unknown> }>;
      final_output: string;
      ms: number;
    }>(
      'POST',
      `/v3/loop/agents/${encodeURIComponent(slug)}/run-workflow`,
      wallet,
      body,
    ),

  // ─── Seller v2: on-chain seller flow upgrade (FEATURE_LOOP_SELLER_V2) ──
  getSellerV2Config: () =>
    getJson<{
      enabled: boolean;
      package_id: string | null;
      bedrock_registry_id: string | null;
      admin_addr: string | null;
      usdc_coin_type: string | null;
      publish_fee_micro: number;
    }>('/v3/loop/seller/v2-config'),

  getSellerAgentEvents: (wallet: string, slugOrId: string, limit = 50) =>
    fetch(`${AGENT_BACKEND_URL}/v3/loop/seller/agents/${encodeURIComponent(slugOrId)}/events?limit=${limit}`, {
      headers: { 'x-wallet-address': wallet },
      cache: 'no-store',
    }).then(async (r) => {
      if (r.status === 404) return { agent_object_id: null, events: [] };
      if (!r.ok) throw new Error(`events ${r.status}`);
      return r.json() as Promise<{
        agent_object_id: string | null;
        events: Array<{
          type: string; tx_digest: string; seq_in_tx: number;
          payload: Record<string, unknown>; timestamp_ms: number;
        }>;
      }>;
    }),

  getSellerOnChainStats: (wallet: string) =>
    fetch(`${AGENT_BACKEND_URL}/v3/loop/seller/me/onchain-stats`, {
      headers: { 'x-wallet-address': wallet },
      cache: 'no-store',
    }).then(async (r) => {
      if (r.status === 404 || r.status === 401) {
        return {
          on_chain: { agents_published: 0, publish_fees_paid: 0, publish_fees_usdc: 0, mutations: 0, revocations: 0 },
          earnings: { earned_total_usdc: '0', calls_total: 0 },
        };
      }
      if (!r.ok) throw new Error(`onchain-stats ${r.status}`);
      return r.json() as Promise<{
        on_chain: { agents_published: number; publish_fees_paid: number; publish_fees_usdc: number; mutations: number; revocations: number };
        earnings: { earned_total_usdc: string; calls_total: number };
      }>;
    }),

  getSellerWalletEvents: (wallet: string, limit = 50) =>
    fetch(`${AGENT_BACKEND_URL}/v3/loop/seller/me/wallet-events?limit=${limit}`, {
      headers: { 'x-wallet-address': wallet },
      cache: 'no-store',
    }).then(async (r) => {
      if (r.status === 404 || r.status === 401) return { wallet, events: [] };
      if (!r.ok) throw new Error(`wallet-events ${r.status}`);
      return r.json() as Promise<{
        wallet: string;
        events: Array<{
          type: string; agent_object_id: string | null;
          tx_digest: string; seq_in_tx: number;
          payload: Record<string, unknown>; timestamp_ms: number;
        }>;
      }>;
    }),

  buildUpdatePricing: (wallet: string, slugOrId: string, body: { sui_object_id?: string; per_iter_min_micro_usdc: number; per_iter_default_micro_usdc: number; max_iter_per_job: number }) =>
    authedJson<{ ptb_bytes_b64: string; agent_object_id: string }>(
      'POST', `/v3/loop/seller/agents/${encodeURIComponent(slugOrId)}/update-pricing`, wallet, body,
    ),

  buildUpdateModel: (wallet: string, slugOrId: string, body: { sui_object_id?: string; new_model_id: string }) =>
    authedJson<{ ptb_bytes_b64: string; agent_object_id: string }>(
      'POST', `/v3/loop/seller/agents/${encodeURIComponent(slugOrId)}/update-model`, wallet, body,
    ),

  buildUpdateManifest: (wallet: string, slugOrId: string, body: { sui_object_id?: string; new_walrus_blob_id: string; manifest_sha256_b64: string }) =>
    authedJson<{ ptb_bytes_b64: string; agent_object_id: string }>(
      'POST', `/v3/loop/seller/agents/${encodeURIComponent(slugOrId)}/update-manifest`, wallet, body,
    ),

  buildRevokeAgent: (wallet: string, slugOrId: string, body: { sui_object_id?: string }) =>
    authedJson<{ ptb_bytes_b64: string; agent_object_id: string }>(
      'POST', `/v3/loop/seller/agents/${encodeURIComponent(slugOrId)}/revoke`, wallet, body,
    ),

  adminWhitelistModel: (wallet: string, model_id: string) =>
    authedJson<{ ptb_bytes_b64: string }>(
      'POST', '/v3/loop/admin/bedrock-whitelist/add', wallet, { model_id },
    ),

  adminRemoveWhitelistModel: (wallet: string, model_id: string) =>
    authedJson<{ ptb_bytes_b64: string }>(
      'POST', '/v3/loop/admin/bedrock-whitelist/remove', wallet, { model_id },
    ),
};

export type WorkflowStep = {
  id: string;
  capability: string;
  phase?: 'capture' | 'organize' | 'distill' | 'express';
  depends_on: string[];
  inputs?: Record<string, unknown>;
  output_schema?: Record<string, string>;
  on_failure?: 'retry-once' | 'halt' | 'continue-skip';
  max_micro_usdc?: number;
  risk_tier?: 'low' | 'medium' | 'high';
};

export type WorkflowYaml = {
  version: 'v1.1';
  name: string;
  para?: { default_kind?: 'project' | 'area' | 'resource'; area_slug?: string };
  steps: WorkflowStep[];
};

/** Best price across rails — UI display only; server is authoritative. */
export function priceFromPricing(p: Listing['pricing'] | undefined): { rail: string; amount: string } | null {
  if (!p) return null;
  for (const k of ['sui_usdc', 'x402', 'mpp'] as const) {
    if (p[k]) return { rail: k, amount: p[k]! };
  }
  return null;
}
