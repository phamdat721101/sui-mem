/**
 * sui-sdk/bedrock/catalog — single source of truth for the Bedrock model
 * catalog that backs:
 *   - the FE seller wizard's `<BedrockModelPicker>` dropdown,
 *   - the BE `sellerPublishService.publish()` validation gate,
 *   - the on-chain `BedrockModelRegistry` whitelist seed (one PTB per id).
 *
 * 12 models × 4 tiers (`fast` | `balanced` | `premium` | `long-context`).
 * Pricing in USD per 1M tokens; numbers reflect the AWS Bedrock public
 * console as of 2026-06-19 — tweak when AWS revises.
 *
 * SOLID:
 *   - SRP: this file owns the catalog. No HTTP, no validation logic, no UI.
 *   - DIP: every consumer imports from `@fhe-ai-context/sui-sdk`.
 *   - OCP: a new model = one entry; `findBedrockModel` / `modelsByTier`
 *     don't need to change.
 */

export type BedrockTier = 'fast' | 'balanced' | 'premium' | 'long-context';

export interface BedrockModel {
  /** Bedrock model id (the on-chain whitelist key). */
  id: string;
  /** Human-readable label for the picker. */
  label: string;
  tier: BedrockTier;
  /** Input price per 1M tokens in USD. */
  in_per_1m_usd: number;
  /** Output price per 1M tokens in USD. */
  out_per_1m_usd: number;
  /** Context window in tokens. */
  ctx_tokens: number;
}

export const BEDROCK_MODEL_CATALOG: readonly BedrockModel[] = Object.freeze([
  // ─── fast (cheap, low-latency CAPTURE / DISTILL) ────────────────────
  { id: 'amazon.nova-micro-v1:0',                 label: 'Nova Micro',                tier: 'fast',          in_per_1m_usd: 0.035, out_per_1m_usd: 0.14,  ctx_tokens: 128_000 },
  { id: 'amazon.nova-lite-v1:0',                  label: 'Nova Lite',                 tier: 'fast',          in_per_1m_usd: 0.06,  out_per_1m_usd: 0.24,  ctx_tokens: 300_000 },
  { id: 'meta.llama4-scout-17b-v1:0',             label: 'Llama 4 Scout 17B',         tier: 'fast',          in_per_1m_usd: 0.17,  out_per_1m_usd: 0.66,  ctx_tokens: 128_000 },

  // ─── balanced (everyday EXPRESS step + most workflows) ─────────────
  { id: 'amazon.nova-pro-v1:0',                   label: 'Nova Pro',                  tier: 'balanced',      in_per_1m_usd: 0.80,  out_per_1m_usd: 3.20,  ctx_tokens: 300_000 },
  { id: 'anthropic.claude-sonnet-4-5-v1:0',       label: 'Claude Sonnet 4.5',         tier: 'balanced',      in_per_1m_usd: 3.00,  out_per_1m_usd: 15.00, ctx_tokens: 200_000 },
  { id: 'meta.llama4-maverick-17b-v1:0',          label: 'Llama 4 Maverick 17B',      tier: 'balanced',      in_per_1m_usd: 0.34,  out_per_1m_usd: 1.34,  ctx_tokens: 128_000 },

  // ─── premium (heavy synthesis, weekly digest, complex reasoning) ───
  { id: 'anthropic.claude-opus-4-5-v1:0',         label: 'Claude Opus 4.5',           tier: 'premium',       in_per_1m_usd: 15.00, out_per_1m_usd: 75.00, ctx_tokens: 200_000 },
  { id: 'anthropic.claude-3-7-sonnet-20250219-v1:0', label: 'Claude 3.7 Sonnet',      tier: 'premium',       in_per_1m_usd: 3.00,  out_per_1m_usd: 15.00, ctx_tokens: 200_000 },
  { id: 'mistral.mistral-large-2411-v1:0',        label: 'Mistral Large 2411',        tier: 'premium',       in_per_1m_usd: 2.00,  out_per_1m_usd: 6.00,  ctx_tokens: 128_000 },

  // ─── long-context (huge documents, deep research) ──────────────────
  { id: 'anthropic.claude-3-5-sonnet-20241022-v2:0', label: 'Claude 3.5 Sonnet 200k',  tier: 'long-context',  in_per_1m_usd: 3.00,  out_per_1m_usd: 15.00, ctx_tokens: 200_000 },
  { id: 'amazon.nova-premier-v1:0',               label: 'Nova Premier 1M',           tier: 'long-context',  in_per_1m_usd: 2.50,  out_per_1m_usd: 12.50, ctx_tokens: 1_000_000 },
  { id: 'cohere.command-a-v1:0',                  label: 'Command A 256k',            tier: 'long-context',  in_per_1m_usd: 2.50,  out_per_1m_usd: 10.00, ctx_tokens: 256_000 },
]);

/** True if `id` matches any catalog entry. O(n) over 12 entries — trivial. */
export function isBedrockModelId(id: string | null | undefined): boolean {
  if (!id) return false;
  for (const m of BEDROCK_MODEL_CATALOG) if (m.id === id) return true;
  return false;
}

/** Return the catalog row for `id`, or null. */
export function findBedrockModel(id: string | null | undefined): BedrockModel | null {
  if (!id) return null;
  for (const m of BEDROCK_MODEL_CATALOG) if (m.id === id) return m;
  return null;
}

/** All models in a given tier. */
export function modelsByTier(tier: BedrockTier): BedrockModel[] {
  return BEDROCK_MODEL_CATALOG.filter((m) => m.tier === tier);
}

/** Default model id for a tier — the first entry. Used by the picker as the
 *  initial selection when the seller picks a tier button. */
export function defaultModelIdForTier(tier: BedrockTier): string {
  const first = modelsByTier(tier)[0];
  return first?.id ?? BEDROCK_MODEL_CATALOG[0].id;
}
