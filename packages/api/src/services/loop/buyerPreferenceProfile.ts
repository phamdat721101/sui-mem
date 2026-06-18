/**
 * services/loop/buyerPreferenceProfile.ts — PRD-W v1.1 buyer preferences vCard.
 *
 * THE ONLY portable cross-seller artifact (PRD-W v1.1 locked sentence).
 * Curated structured object (~20 fields max) — NOT engagement history.
 * Buyer-only writable; readable by sellers buyer explicitly chooses to
 * share with at hire-time.
 *
 * SOLID: SRP — vCard CRUD. Sui access control lives in routes.
 */

import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { MemWalMirror } from './memoryService';
import { buyerPreferencesNamespace } from './memoryService';

/** Curated schema — strict allowlist; new fields require a v1.2 amendment. */
export interface BuyerPreferenceVCard {
  voice?: 'casual' | 'formal' | 'narrative' | 'analytical' | 'technical';
  voice_locale?: string;          // BCP-47 e.g. "en-US", "vi-VN"
  preferred_length_words?: number; // 100..5000
  preferred_platforms?: string[];  // ["twitter", "linkedin"]
  tone_template_walrus_blob_id?: string;
  active_hours_utc_minute_start?: number;  // 0..1439
  active_hours_utc_minute_end?: number;
  brand_keywords?: string[];
  avoid_keywords?: string[];
  /** Free-form note: max 500 chars. */
  notes?: string;
}

const VOICES = new Set(['casual', 'formal', 'narrative', 'analytical', 'technical']);

export interface VCardDeps {
  pool: Pool;
  mirror: MemWalMirror;
  logger: Logger;
}

export class BuyerPreferenceProfileService {
  constructor(private readonly deps: VCardDeps) {}

  /** Validate + sanitize an incoming vCard payload. */
  validate(raw: unknown): BuyerPreferenceVCard {
    if (!raw || typeof raw !== 'object') return {};
    const r = raw as Record<string, unknown>;
    const out: BuyerPreferenceVCard = {};

    if (typeof r.voice === 'string' && VOICES.has(r.voice)) out.voice = r.voice as BuyerPreferenceVCard['voice'];
    if (typeof r.voice_locale === 'string' && r.voice_locale.length <= 10) out.voice_locale = r.voice_locale;
    if (typeof r.preferred_length_words === 'number'
      && r.preferred_length_words >= 100
      && r.preferred_length_words <= 5000) {
      out.preferred_length_words = Math.floor(r.preferred_length_words);
    }
    if (Array.isArray(r.preferred_platforms)) {
      out.preferred_platforms = r.preferred_platforms
        .filter((p): p is string => typeof p === 'string' && p.length <= 32)
        .slice(0, 8);
    }
    if (typeof r.tone_template_walrus_blob_id === 'string'
      && r.tone_template_walrus_blob_id.length <= 128) {
      out.tone_template_walrus_blob_id = r.tone_template_walrus_blob_id;
    }
    if (typeof r.active_hours_utc_minute_start === 'number'
      && r.active_hours_utc_minute_start >= 0
      && r.active_hours_utc_minute_start < 1440) {
      out.active_hours_utc_minute_start = Math.floor(r.active_hours_utc_minute_start);
    }
    if (typeof r.active_hours_utc_minute_end === 'number'
      && r.active_hours_utc_minute_end >= 0
      && r.active_hours_utc_minute_end < 1440) {
      out.active_hours_utc_minute_end = Math.floor(r.active_hours_utc_minute_end);
    }
    for (const arr of ['brand_keywords', 'avoid_keywords'] as const) {
      if (Array.isArray(r[arr])) {
        out[arr] = (r[arr] as unknown[])
          .filter((k): k is string => typeof k === 'string' && k.length <= 64)
          .slice(0, 16);
      }
    }
    if (typeof r.notes === 'string' && r.notes.length <= 500) out.notes = r.notes;
    return out;
  }

  async save(buyer_addr: string, raw: unknown): Promise<BuyerPreferenceVCard> {
    const sanitized = this.validate(raw);
    const namespace = buyerPreferencesNamespace(buyer_addr);
    await this.deps.mirror
      .remember({ namespace, text: JSON.stringify(sanitized) })
      .catch((e: Error) =>
        this.deps.logger.warn({ err: e.message, buyer: buyer_addr.slice(0, 12) }, 'vcard:mirror_failed'));
    // Postgres mirror — append-only history (latest wins by created_at).
    await this.deps.pool.query(
      `INSERT INTO cognitive_memories (brain_id, namespace, text, cognitive_level)
            VALUES ($1, $2, $3, 4)`,
      [buyer_addr, namespace, JSON.stringify(sanitized)],
    );
    return sanitized;
  }

  async read(buyer_addr: string): Promise<BuyerPreferenceVCard | null> {
    const namespace = buyerPreferencesNamespace(buyer_addr);
    const r = await this.deps.pool.query<{ text: string }>(
      `SELECT text FROM cognitive_memories
        WHERE namespace = $1 ORDER BY created_at DESC LIMIT 1`,
      [namespace],
    );
    if (!r.rowCount) return null;
    try { return JSON.parse(r.rows[0].text) as BuyerPreferenceVCard; }
    catch { return null; }
  }
}
