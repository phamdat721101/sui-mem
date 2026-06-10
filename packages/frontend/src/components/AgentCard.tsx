'use client';

import Link from 'next/link';
import type { Listing } from '@/lib/api';
import { priceFromPricing } from '@/lib/api';

const RAIL_LABEL: Record<string, string> = {
  sui_usdc: 'Sui-USDC',
  x402: 'USDC',
  mpp: 'MPP',
};

/**
 * AgentCard — paid x402 listing card.
 *
 * SOLID:
 *  - SRP: pure render — no fetch, no state. Pages own data; the card owns shape.
 *  - DIP: takes a `Listing` (the canonical wire shape) — never the API URL.
 */
export function AgentCard({ listing }: { listing: Listing }) {
  const price = priceFromPricing(listing.pricing);
  const ownerShort = listing.id.slice(0, 6) + '…' + listing.id.slice(-4);
  const description =
    listing.description?.trim() ||
    listing.short_description?.trim() ||
    listing.persona?.system_prompt?.slice(0, 140) ||
    'Encrypted AI agent on Sui.';

  return (
    <Link
      href={`/agent/${listing.slug}`}
      className="agent-card-border encryption-glow group flex h-full flex-col gap-3 rounded-xl bg-surface p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <span className="material-symbols-outlined text-[20px]">smart_toy</span>
        </div>
        <span className="inline-flex items-center gap-1 rounded-full border border-secondary/30 bg-secondary/10 px-2 py-0.5 font-mono text-[10px] text-secondary">
          <span className="material-symbols-outlined text-[12px]">hub</span>
          Sui
        </span>
      </div>

      <div className="space-y-1">
        <h3 className="line-clamp-1 font-headline text-base font-semibold leading-snug text-on-surface group-hover:text-primary">
          {listing.title}
        </h3>
        <p className="line-clamp-2 text-sm text-on-surface-variant">{description}</p>
      </div>

      {(listing.tags?.length ?? 0) > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {listing.tags!.slice(0, 4).map((tag) => (
            <span
              key={tag}
              className="rounded-full border border-outline-variant/40 px-2 py-0.5 font-mono text-[10px] text-on-surface-variant"
            >
              #{tag}
            </span>
          ))}
        </div>
      )}

      <div className="mt-auto flex items-end justify-between gap-2 border-t border-outline-variant/20 pt-3">
        <span className="font-mono text-[11px] text-on-surface-variant">{ownerShort}</span>
        {price ? (
          <span className="font-mono text-sm text-on-surface">
            ${Number(price.amount).toFixed(2)}
            <span className="ml-1 font-mono text-[10px] text-on-surface-variant">
              {RAIL_LABEL[price.rail] ?? price.rail} / call
            </span>
          </span>
        ) : (
          <span className="font-mono text-[10px] uppercase text-on-surface-variant">Free</span>
        )}
      </div>

      <div className="-mt-1 flex items-center gap-1">
        <span className="font-mono text-[10px] text-on-surface-variant">/api/v1/{listing.slug}</span>
      </div>
    </Link>
  );
}
