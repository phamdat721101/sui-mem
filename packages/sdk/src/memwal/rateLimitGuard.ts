/**
 * memwal/rateLimitGuard.ts — token-bucket guard mirroring MemWal relayer caps.
 *
 * Three concurrent windows (per PRD-06 §6.4):
 *   - per-delegate / minute   (cap 30 pts)
 *   - per-account / minute    (cap 60 pts)
 *   - per-account / hour      (cap 500 pts)
 *
 * Storage:
 *   - Redis sorted sets when a client is provided (production).
 *   - In-memory Map fallback when no Redis is given (tests, local dev).
 *
 * SOLID:
 *   - SRP: this file owns rate-limiting only. No business logic.
 *   - DIP: takes a `RateLimitRedisLike` interface, not ioredis directly.
 *   - OCP: adding a new window = one entry in the WINDOWS array.
 */

import type { RateLimitRedisLike } from './types';
import { MEMWAL_RATE_CAPS } from './types';
import { OpenXMemWalRateLimitError } from './errors';

interface Window {
  scope: 'delegate-minute' | 'account-minute' | 'account-hour';
  windowMs: number;
  cap: number;
  keyOf(accountId: string, delegateHash: string): string;
}

const WINDOWS: readonly Window[] = [
  {
    scope: 'delegate-minute',
    windowMs: 60_000,
    cap: MEMWAL_RATE_CAPS.perDelegateMinute,
    keyOf: (acc, del) => `openx:memwal:rl:del:${acc}:${del}:m`,
  },
  {
    scope: 'account-minute',
    windowMs: 60_000,
    cap: MEMWAL_RATE_CAPS.perAccountMinute,
    keyOf: (acc) => `openx:memwal:rl:acc:${acc}:m`,
  },
  {
    scope: 'account-hour',
    windowMs: 3_600_000,
    cap: MEMWAL_RATE_CAPS.perAccountHour,
    keyOf: (acc) => `openx:memwal:rl:acc:${acc}:h`,
  },
];

interface MemoryBucket {
  timestamps: number[];
}

export class RateLimitGuard {
  private readonly memory = new Map<string, MemoryBucket>();

  constructor(private readonly redis?: RateLimitRedisLike) {}

  /**
   * Charge `points` against all three windows. Throws OpenXMemWalRateLimitError
   * with `retryAfterMs` if any window would be breached. Atomic-ish:
   * we read all three sizes BEFORE writing, so a denial doesn't poison buckets.
   */
  async charge(accountId: string, delegateHash: string, points: number): Promise<void> {
    const now = Date.now();

    // Pre-flight: check every window first. Fail closed without writing.
    for (const w of WINDOWS) {
      const key = w.keyOf(accountId, delegateHash);
      const used = await this.size(key, now - w.windowMs);
      if (used + points > w.cap) {
        const retryAfterMs = await this.estimateRetry(key, w, now, points);
        throw new OpenXMemWalRateLimitError(w.scope, retryAfterMs);
      }
    }

    // Charge: emit `points` distinct entries so future ZCARD reflects cost-weighting.
    for (const w of WINDOWS) {
      const key = w.keyOf(accountId, delegateHash);
      for (let i = 0; i < points; i++) {
        await this.add(key, now + i, `${now}-${i}-${Math.random().toString(36).slice(2, 8)}`);
      }
      // Best-effort TTL so stale keys don't linger after silent traffic.
      if (this.redis) await this.redis.expire(key, Math.ceil(w.windowMs / 1000) + 5);
    }
  }

  /** Returns the current usage across all three windows for telemetry. */
  async snapshot(accountId: string, delegateHash: string): Promise<{
    delegateMinute: number;
    accountMinute: number;
    accountHour: number;
  }> {
    const now = Date.now();
    const [del, accM, accH] = await Promise.all(
      WINDOWS.map((w) => this.size(w.keyOf(accountId, delegateHash), now - w.windowMs)),
    );
    return { delegateMinute: del, accountMinute: accM, accountHour: accH };
  }

  // ─── private storage adapters ─────────────────────────────────────────

  private async size(key: string, since: number): Promise<number> {
    if (this.redis) {
      await this.redis.zremrangebyscore(key, 0, since);
      return await this.redis.zcard(key);
    }
    const bucket = this.memory.get(key);
    if (!bucket) return 0;
    bucket.timestamps = bucket.timestamps.filter((t) => t > since);
    return bucket.timestamps.length;
  }

  private async add(key: string, score: number, member: string): Promise<void> {
    if (this.redis) {
      await this.redis.zadd(key, score, member);
      return;
    }
    const bucket = this.memory.get(key) ?? { timestamps: [] };
    bucket.timestamps.push(score);
    this.memory.set(key, bucket);
  }

  /** Best-effort: ms until the oldest entry rolls out enough to allow `points`. */
  private async estimateRetry(
    key: string,
    w: Window,
    now: number,
    points: number,
  ): Promise<number> {
    if (this.redis) {
      // Without ZRANGEBYSCORE in our minimal interface, fall back to window length.
      return w.windowMs;
    }
    const bucket = this.memory.get(key);
    if (!bucket || bucket.timestamps.length === 0) return 1_000;
    const sorted = [...bucket.timestamps].sort((a, b) => a - b);
    const idx = Math.max(0, sorted.length - w.cap + points - 1);
    const releaseAt = sorted[idx] + w.windowMs;
    return Math.max(0, releaseAt - now);
  }
}
