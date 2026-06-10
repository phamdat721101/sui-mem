'use client';

import Link from 'next/link';
import type { MemWalBrain } from '@/lib/api';

/**
 * MemWalBrainCard — Walrus + MemWal-tier brain card.
 *
 * SOLID:
 *  - SRP: pure render of one MemWalBrain row. No fetch.
 *  - DIP: takes the canonical MemWalBrain shape; the page owns where it came from.
 */
export function MemWalBrainCard({ brain }: { brain: MemWalBrain }) {
  const sellerShort = brain.seller_wallet.slice(0, 6) + '…' + brain.seller_wallet.slice(-4);
  return (
    <Link
      href={`/agent/${brain.sui_object_id}`}
      className="agent-card-border encryption-glow group flex h-full flex-col gap-3 rounded-xl bg-surface p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-tertiary/10 text-tertiary">
          <span className="material-symbols-outlined text-[20px]">psychology</span>
        </div>
        <span className="matrix-chip inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px]">
          <span className="material-symbols-outlined text-[12px]">memory</span>
          L{brain.cognitive_level}
        </span>
      </div>

      <div className="space-y-1">
        <h3 className="line-clamp-1 font-headline text-base font-semibold leading-snug text-on-surface group-hover:text-primary">
          {brain.title}
        </h3>
        {brain.description && (
          <p className="line-clamp-2 text-sm text-on-surface-variant">{brain.description}</p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1">
        <span className="rounded-full border border-outline-variant/40 px-2 py-0.5 font-mono text-[10px] text-on-surface-variant">
          {brain.namespace}
        </span>
        {brain.attestation_required > 0 && (
          <span className="rounded-full border border-secondary/30 bg-secondary/10 px-2 py-0.5 font-mono text-[10px] text-secondary">
            TEE-attested
          </span>
        )}
      </div>

      <div className="mt-auto flex items-end justify-between gap-2 border-t border-outline-variant/20 pt-3">
        <span className="font-mono text-[11px] text-on-surface-variant">{sellerShort}</span>
        <span className="font-mono text-sm text-on-surface">
          ${Number(brain.price_per_query_usdc).toFixed(4)}
          <span className="ml-1 font-mono text-[10px] text-on-surface-variant">/ query</span>
        </span>
      </div>
    </Link>
  );
}
