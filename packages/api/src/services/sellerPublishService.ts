/**
 * sellerPublishService — atomic seller publish (Sui-native).
 *
 * One Postgres transaction: seller upsert → brain INSERT → agent INSERT.
 * Returns the canonical handles (slug, listing_url, knowledge_url) so the
 * publish wizard's success card deeplinks without a second round-trip.
 *
 * SOLID:
 *   - SRP: this module owns "create seller + brain + agent" as one unit.
 *   - DIP: pool is module-level; a transactional client is acquired via
 *     pool.connect() so the INSERTs roll back together on any failure.
 *   - OCP: a new field = one validator entry + one INSERT column; the
 *     pipeline shape doesn't change.
 *
 * Sui-only — the chain literal is fixed to 'sui-testnet' or 'sui-mainnet'.
 * Pricing rails are sui_usdc + x402 + mpp (no fherc20).
 */

import { createHash } from 'node:crypto';
import { isBedrockModelId } from '@fhe-ai-context/sui-sdk';
import { pool } from '../db';

export type Domain =
  | 'marketing'
  | 'finance'
  | 'research'
  | 'engineering'
  | 'generalist'
  | 'other';

export type Tier = 'basic' | 'verified' | 'tee_attested';
export type Rail = 'x402' | 'mpp' | 'sui_usdc';
export type Chain = 'sui-testnet' | 'sui-mainnet';

const DOMAINS: Domain[] = [
  'marketing', 'finance', 'research', 'engineering', 'generalist', 'other',
];
const TIERS: Tier[] = ['basic', 'verified', 'tee_attested'];
const RAILS: Rail[] = ['x402', 'mpp', 'sui_usdc'];
const CHAINS: Chain[] = ['sui-testnet', 'sui-mainnet'];
const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,40}$/;

export interface SellerProfileInput {
  display_name?: string;
  bio?: string;
  contact_email?: string;
  support_url?: string;
}

export interface SellerPublishInput {
  title: string;
  short_description: string;
  long_description?: string;
  domain: Domain;
  tags?: string[];
  persona_system_prompt: string;
  persona_tools?: string[];
  pricing_amount_usdc: string;
  pricing_rails: Rail[];
  chain?: Chain;
  slug?: string;
  verification_tier?: Tier;
  seller_profile?: SellerProfileInput;
  /** Bedrock model id — when present, MUST be in BEDROCK_MODEL_CATALOG. */
  default_model_id?: string;
  /** Sui tx digest of the on-chain $1 USDC publish-fee payment. Optional
   *  for legacy publishes; required for v2 on-chain publishes. */
  fee_tx_digest?: string;
  /** PRD-X2 — agent kind. Defaults to 'api' for back-compat with the
   *  legacy single-form wizard. 'workflow' requires the 3 fields below. */
  kind?: 'api' | 'workflow' | 'skill';
  /** Walrus blob id of the workflow YAML; required when kind='workflow'. */
  workflow_walrus_blob_id?: string;
  /** PARA areas (1..16) declared at publish time; required when kind='workflow'. */
  area_slugs?: string[];
  /** Seller's `AgentV11Extension` shared object id from the upgrade PTB.
   *  Persists as a hot-path Postgres column for marketplace listing reads. */
  agent_v11_extension_object_id?: string;
}

export interface SellerPublishResult {
  agent_id: string;
  brain_id: number;
  seller_id: number;
  slug: string;
  domain: Domain;
  verification_tier: Tier;
  chain: Chain;
  listing_url: string;
  knowledge_url: string;
  manifest_yaml: string;
}

function httpErr(message: string, status: number): Error {
  const e = new Error(message) as Error & { status?: number };
  e.status = status;
  return e;
}

function slugify(s: string): string {
  return (
    s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agent'
  );
}

function validate(input: SellerPublishInput): void {
  if (!input.title || input.title.length < 3 || input.title.length > 120) {
    throw httpErr('title must be 3..120 chars', 400);
  }
  if (!input.short_description || input.short_description.length < 10 || input.short_description.length > 240) {
    throw httpErr('short_description must be 10..240 chars', 400);
  }
  if (!DOMAINS.includes(input.domain)) {
    throw httpErr(`invalid domain (allowed: ${DOMAINS.join(', ')})`, 400);
  }
  if (input.tags && input.tags.length > 10) throw httpErr('at most 10 tags', 400);
  if (!input.persona_system_prompt || input.persona_system_prompt.trim().length < 10) {
    throw httpErr('persona_system_prompt must be ≥10 chars', 400);
  }
  const amount = Number(input.pricing_amount_usdc);
  if (!(amount > 0 && amount <= 1000)) {
    throw httpErr('pricing_amount_usdc must be in (0, 1000]', 400);
  }
  if (!Array.isArray(input.pricing_rails) || input.pricing_rails.length === 0) {
    throw httpErr('pricing_rails must be non-empty', 400);
  }
  for (const r of input.pricing_rails) {
    if (!RAILS.includes(r)) throw httpErr(`invalid rail: ${r}`, 400);
  }
  if (input.slug !== undefined && !SLUG_RE.test(input.slug)) {
    throw httpErr('slug must match ^[a-z0-9][a-z0-9-]{2,40}$', 400);
  }
  if (input.verification_tier && !TIERS.includes(input.verification_tier)) {
    throw httpErr(`invalid verification_tier (allowed: ${TIERS.join(', ')})`, 400);
  }
  if (input.chain && !CHAINS.includes(input.chain)) {
    throw httpErr(`invalid chain (allowed: ${CHAINS.join(', ')})`, 400);
  }
  if (input.default_model_id && !isBedrockModelId(input.default_model_id)) {
    throw httpErr(`bedrock_model_unsupported: ${input.default_model_id}`, 400);
  }
  if (input.fee_tx_digest !== undefined && typeof input.fee_tx_digest !== 'string') {
    throw httpErr('fee_tx_digest must be a string', 400);
  }
  // PRD-X2 — kind=workflow validation. kind defaults to 'api' (legacy).
  const kind = input.kind ?? 'api';
  if (!['api', 'workflow', 'skill'].includes(kind)) {
    throw httpErr(`invalid kind (allowed: api | workflow | skill)`, 400);
  }
  if (kind === 'skill') {
    throw httpErr('kind=skill not yet supported (PRD-15 deferred)', 400);
  }
  if (kind === 'workflow') {
    if (!input.workflow_walrus_blob_id) {
      throw httpErr('workflow_walrus_blob_id required when kind=workflow', 400);
    }
    if (!Array.isArray(input.area_slugs) || input.area_slugs.length === 0 || input.area_slugs.length > 16) {
      throw httpErr('area_slugs must be 1..16 entries when kind=workflow', 400);
    }
  }
}

function renderManifest(input: SellerPublishInput, slug: string, owner: string, rails: Rail[]): string {
  const tier = input.verification_tier ?? 'basic';
  const tags = (input.tags ?? []).map((t) => `'${t.replace(/'/g, '')}'`).join(', ');
  const tools = (input.persona_tools ?? []).map((t) => `'${t.replace(/'/g, '')}'`).join(', ');
  const railList = rails.map((r) => `'${r}'`).join(', ');
  return [
    `manifest_version: '1.0'`,
    `listing:`,
    `  slug: ${slug}`,
    `  title: ${JSON.stringify(input.title)}`,
    `  short: ${JSON.stringify(input.short_description)}`,
    `  domain: ${input.domain}`,
    `  tags: [${tags}]`,
    `owner:`,
    `  wallet_address: '${owner}'`,
    `pricing:`,
    `  mode: fixed`,
    `  amount_usdc: '${input.pricing_amount_usdc}'`,
    `  currency: USDC`,
    `  rails: [${railList}]`,
    `verification:`,
    `  tier: ${tier}`,
    `persona:`,
    `  system_prompt: ${JSON.stringify(input.persona_system_prompt)}`,
    `  tools: [${tools}]`,
    ``,
  ].join('\n');
}

export async function publish(
  walletAddress: string,
  input: SellerPublishInput,
  opts?: { apiBaseUrl?: string },
): Promise<SellerPublishResult> {
  validate(input);

  const owner = walletAddress.toLowerCase();
  const slug = input.slug ?? slugify(input.title);
  const tier: Tier = input.verification_tier ?? 'basic';
  const chain: Chain = input.chain ?? 'sui-testnet';
  const tags = input.tags ?? [];
  const apiBase = opts?.apiBaseUrl ?? '';

  const pricing: Record<Rail, string | null> = { x402: null, mpp: null, sui_usdc: null };
  for (const r of input.pricing_rails) pricing[r] = input.pricing_amount_usdc;

  const persona = {
    system_prompt: input.persona_system_prompt.trim(),
    tools: input.persona_tools ?? [],
  };

  const manifestYaml = renderManifest(input, slug, owner, input.pricing_rails);
  const manifestHash = createHash('sha256').update(manifestYaml).digest();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // §1 — Seller upsert.
    const sellerRes = await client.query(
      `INSERT INTO sellers (wallet_address, display_name, bio, contact_email, support_url, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now())
       ON CONFLICT (wallet_address) DO UPDATE SET
         display_name  = COALESCE(EXCLUDED.display_name,  sellers.display_name),
         bio           = COALESCE(EXCLUDED.bio,           sellers.bio),
         contact_email = COALESCE(EXCLUDED.contact_email, sellers.contact_email),
         support_url   = COALESCE(EXCLUDED.support_url,   sellers.support_url),
         updated_at    = now()
       RETURNING id`,
      [
        owner,
        input.seller_profile?.display_name ?? owner,
        input.seller_profile?.bio ?? null,
        input.seller_profile?.contact_email ?? null,
        input.seller_profile?.support_url ?? null,
      ],
    );
    const sellerId = sellerRes.rows[0].id as number;

    // §2 — Brain INSERT.
    const brainRes = await client.query(
      `INSERT INTO brains (owner_address, title, description, tags, published, chain)
       VALUES ($1, $2, $3, $4, true, $5)
       RETURNING id`,
      [owner, input.title, input.long_description ?? input.short_description, tags, chain],
    );
    const brainId = brainRes.rows[0].id as number;

    // §3 — Agent INSERT.
    const kind = input.kind ?? 'api';
    const agentRes = await client.query(
      `INSERT INTO agents (
         brain_id, owner_address, chain, persona, pricing,
         published, slug, domain, short_description, verification_tier,
         manifest_yaml, manifest_hash, seller_id, fee_tx_digest,
         kind, workflow_walrus_blob_id
       )
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb,
               true, $6, $7, $8, $9,
               $10, $11, $12, $13,
               $14, $15)
       RETURNING id`,
      [
        brainId, owner, chain, JSON.stringify(persona), JSON.stringify(pricing),
        slug, input.domain, input.short_description, tier,
        manifestYaml, manifestHash, sellerId, input.fee_tx_digest ?? null,
        kind, input.workflow_walrus_blob_id ?? null,
      ],
    );
    const agentId = agentRes.rows[0].id as string;

    await client.query('COMMIT');

    return {
      agent_id: agentId,
      brain_id: brainId,
      seller_id: sellerId,
      slug,
      domain: input.domain,
      verification_tier: tier,
      chain,
      listing_url: `${apiBase}/agent/${slug}`,
      knowledge_url: `${apiBase}/brain-sui/${brainId}`,
      manifest_yaml: manifestYaml,
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    const err = e as { code?: string; constraint?: string; message?: string };
    if (err?.code === '23505' && /agents_slug_key|agents_slug/.test(String(err?.constraint ?? err?.message ?? ''))) {
      throw httpErr('slug already taken', 409);
    }
    throw e;
  } finally {
    client.release();
  }
}
