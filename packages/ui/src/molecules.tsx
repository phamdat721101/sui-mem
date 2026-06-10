/**
 * Molecule UI components for FHE Second Brain v1.0.
 *
 * SOLID:
 * - Each molecule has a single product responsibility from `docs/UNIFIED_FLOW_SPEC.md`.
 * - Composes primitives — no styling drift.
 * - Pure props in / JSX out. No side effects, no fetch calls.
 *
 * Naming aligns with the spec's "Components" section.
 */
import * as React from 'react';
import { cn } from './utils';
import { Badge, Card, Stepper } from './primitives';

// ---------- BrainCard -------------------------------------------------------

export interface BrainCardProps {
  title: string;
  description: string;
  tags: string[];
  /** Number of stored chunks; rendered as "47 chunks" if > 0. */
  chunkCount?: number;
  /** Truncated owner address, e.g. "0xAb3...c0d". */
  ownerAddress?: string;
  /** Internal chain hint; rendered as a small badge in the corner. */
  chain?: 'sui';
  /** Tier label shown to humans. Trumps the raw `chain` if provided. */
  tier?: 'standard' | 'trustless';
  onOpen?: () => void;
}

const TIER_LABEL: Record<NonNullable<BrainCardProps['tier']>, string> = {
  standard: 'Standard',
  trustless: 'Trustless',
};

const CHAIN_LABEL: Record<NonNullable<BrainCardProps['chain']>, string> = {
  sui: 'Sui',
};

export const BrainCard: React.FC<BrainCardProps> = ({
  title,
  description,
  tags,
  chunkCount,
  ownerAddress,
  chain,
  tier,
  onOpen,
}) => {
  const tierLabel = tier ? TIER_LABEL[tier] : chain ? CHAIN_LABEL[chain] : undefined;
  return (
    <Card interactive onClick={onOpen} className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <h3 className="flex items-center gap-2 text-base font-semibold text-on-surface">
          <span aria-hidden>🧠</span>
          {title}
        </h3>
        {tierLabel && <Badge tone="encrypted">{tierLabel}</Badge>}
      </div>
      <p className="line-clamp-2 text-sm text-on-surface-variant">{description}</p>
      <div className="flex flex-wrap gap-1">
        {tags.map((t) => (
          <Badge key={t} tone="default">
            {t}
          </Badge>
        ))}
      </div>
      <div className="flex items-center justify-between text-xs text-text-muted">
        <span>
          {typeof chunkCount === 'number' ? `${chunkCount} chunks` : 'No chunks yet'}
          {ownerAddress ? ` • by ${ownerAddress}` : ''}
        </span>
        <span className="text-primary">Chat with brain →</span>
      </div>
    </Card>
  );
};

// ---------- ChatBubble ------------------------------------------------------

export type ChatRole = 'user' | 'assistant';
export type ChatMode = 'learn' | 'store';

export interface ChatBubbleProps {
  role: ChatRole;
  /** Coloring: learn=indigo (default), store=emerald. Only relevant for `user` role. */
  mode?: ChatMode;
  sources?: string[];
  /** Optional attestation badge (Phala / Seal / FHE) shown on assistant messages. */
  attestation?: { provider: string; verified: boolean };
  children: React.ReactNode;
}

export const ChatBubble: React.FC<ChatBubbleProps> = ({
  role,
  mode = 'learn',
  sources,
  attestation,
  children,
}) => {
  const isUser = role === 'user';
  const accent = mode === 'store' ? 'border-l-secondary' : 'border-l-primary';
  return (
    <div className={cn('flex w-full', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-lg border-l-4 bg-card p-3 text-sm text-on-surface',
          isUser ? accent : 'border-l-primary',
        )}
      >
        <div>{children}</div>
        {(sources?.length || attestation) && (
          <div className="mt-2 flex flex-wrap gap-2">
            {sources?.length ? (
              <Badge tone="default" icon={<span aria-hidden>📎</span>}>
                {sources.length} source{sources.length === 1 ? '' : 's'}
              </Badge>
            ) : null}
            {attestation && (
              <Badge tone={attestation.verified ? 'success' : 'warning'} icon={<span aria-hidden>🛡️</span>}>
                {attestation.verified
                  ? `${attestation.provider} verified`
                  : `${attestation.provider} unverified`}
              </Badge>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

// ---------- ChainTierPicker -------------------------------------------------

export type Tier = 'standard' | 'trustless';

export interface ChainTierPickerProps {
  value?: Tier;
  onChange: (tier: Tier) => void;
}

const TIER_DETAIL: Record<Tier, { headline: string; sub: string; bullets: string[] }> = {
  standard: {
    headline: 'Standard',
    sub: 'Faster · Lower fees',
    bullets: [
      'Walrus blob storage on Sui',
      'Per-namespace cognitive memory (L1–L5)',
      'Best for high-throughput agent traffic',
    ],
  },
  trustless: {
    headline: 'Trustless',
    sub: 'Mainnet · Threshold · TEE-attested',
    bullets: [
      'Seal IBE + threshold key servers on Sui',
      'Walrus encrypted blob storage',
      'Phala TEE inference with attestation',
    ],
  },
};

export const ChainTierPicker: React.FC<ChainTierPickerProps> = ({ value, onChange }) => (
  <div role="radiogroup" aria-label="Privacy tier" className="grid gap-3 sm:grid-cols-2">
    {(Object.keys(TIER_DETAIL) as Tier[]).map((tier) => {
      const info = TIER_DETAIL[tier];
      const selected = value === tier;
      return (
        <button
          key={tier}
          type="button"
          role="radio"
          aria-checked={selected}
          onClick={() => onChange(tier)}
          className={cn(
            'rounded-lg border bg-card p-4 text-left transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
            selected
              ? 'border-primary-container shadow-encryption-glow'
              : 'border-border hover:border-outline',
          )}
        >
          <div className="flex items-center justify-between">
            <h4 className="text-base font-semibold text-on-surface">{info.headline}</h4>
            {selected && <Badge tone="encrypted">Selected</Badge>}
          </div>
          <p className="mt-1 text-xs text-on-surface-variant">{info.sub}</p>
          <ul className="mt-3 space-y-1 text-xs text-text-muted">
            {info.bullets.map((b) => (
              <li key={b}>• {b}</li>
            ))}
          </ul>
        </button>
      );
    })}
  </div>
);

// ---------- AttestationReceipt ----------------------------------------------

export interface AttestationReceiptProps {
  provider: string;
  /** Opaque cryptographic quote (long string). */
  quote: string;
  verified: boolean;
  issuedAt: string;
}

export const AttestationReceipt: React.FC<AttestationReceiptProps> = ({
  provider,
  quote,
  verified,
  issuedAt,
}) => (
  <details className="group rounded-lg border border-border bg-surface-container p-3 text-xs">
    <summary className="flex cursor-pointer items-center justify-between gap-2 text-on-surface">
      <span className="flex items-center gap-2">
        <span aria-hidden>🛡️</span>
        {provider} {verified ? 'verified' : 'unverified'}
      </span>
      <span className="text-text-muted">{new Date(issuedAt).toLocaleString()}</span>
    </summary>
    <pre className="mt-2 max-h-40 overflow-auto rounded bg-surface-container-low p-2 font-mono text-[10px] text-on-surface-variant">
      {quote}
    </pre>
  </details>
);

// ---------- KYABadge --------------------------------------------------------

export interface KYABadgeProps {
  /** 0..100 reputation; undefined hides reputation. */
  reputation?: number;
  verified: boolean;
}

export const KYABadge: React.FC<KYABadgeProps> = ({ verified, reputation }) => (
  <Badge tone={verified ? 'success' : 'warning'} icon={<span aria-hidden>{verified ? '✓' : '?'}</span>}>
    {verified
      ? `Verified agent${typeof reputation === 'number' ? ` · ${reputation}/100` : ''}`
      : 'Unverified'}
  </Badge>
);

// ---------- MigrationStepper ------------------------------------------------

export interface MigrationStepperProps {
  /** Zero-based current step index across the 4-step migration. */
  current: number;
  failedAt?: number;
}

const MIGRATION_STEPS = [
  { label: 'Decrypting on source tier', description: 'Using your existing permit' },
  { label: 'Re-encrypting for target tier', description: 'New identity-based key' },
  { label: 'Uploading to target storage', description: 'Walrus or platform store' },
  { label: 'Registering on target chain', description: 'New brain published' },
] as const;

export const MigrationStepper: React.FC<MigrationStepperProps> = ({ current, failedAt }) => (
  <Stepper steps={MIGRATION_STEPS} current={current} failed={failedAt !== undefined ? [failedAt] : []} />
);

// ---------- WalletPill ------------------------------------------------------

export interface WalletPillProps {
  /** Full address; rendered truncated. */
  address: string;
  chain?: 'sui';
  onCopy?: () => void;
}

function truncate(addr: string): string {
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export const WalletPill: React.FC<WalletPillProps> = ({ address, chain, onCopy }) => (
  <button
    type="button"
    onClick={onCopy}
    className="inline-flex items-center gap-2 rounded-full border border-border bg-surface-container px-3 py-1 text-xs text-on-surface hover:bg-surface-container-high"
  >
    <span className="font-mono">{truncate(address)}</span>
    {chain && <Badge tone="default">Sui</Badge>}
  </button>
);

// ---------- PriceChip ------------------------------------------------------
// USP: every brain card and every agent-facing endpoint shows the per-query
// price up-front. SOLID: single responsibility — render a price; nothing else.

export interface PriceChipProps {
  /** Human amount (e.g. "0.01"). Use plain string so callers control rounding. */
  amount: string;
  /** Default "USDC". Allow override for FHERC20 etc. */
  currency?: string;
  /** "per query" by default; "/mo" for subscription contexts. */
  unit?: string;
}

export const PriceChip: React.FC<PriceChipProps> = ({
  amount,
  currency = 'USDC',
  unit = 'per query',
}) => (
  <Badge tone="success" icon={<span aria-hidden>💸</span>}>
    {amount} {currency} <span className="opacity-70">· {unit}</span>
  </Badge>
);

// ---------- AgentIdBadge ----------------------------------------------------
// Renders an ERC-8004 agent identity. `verified=true` ⇒ green tick, else neutral.
// Reuses KYABadge styling but always shows a truncated address as the primary
// affordance — agents *are* their address, unlike human KYA.

export interface AgentIdBadgeProps {
  agentAddress: string;
  verified?: boolean;
  reputation?: number;
}

function shortAddr(addr: string): string {
  return addr.length > 10 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

export const AgentIdBadge: React.FC<AgentIdBadgeProps> = ({
  agentAddress,
  verified,
  reputation,
}) => (
  <Badge
    tone={verified ? 'success' : 'default'}
    icon={<span aria-hidden>{verified ? '🤖✓' : '🤖'}</span>}
  >
    <span className="font-mono">{shortAddr(agentAddress)}</span>
    {typeof reputation === 'number' && <span className="opacity-70"> · {reputation}/100</span>}
  </Badge>
);

// ---------- AttestationBadge -----------------------------------------------
// Compact inline badge surfaced next to TEE-attested answers. The full
// receipt (with the quote) is rendered by <AttestationReceipt> further down.

export interface AttestationBadgeProps {
  provider: 'phala-tee' | 'seal-threshold' | string;
  verified: boolean;
  onView?: () => void;
}

export const AttestationBadge: React.FC<AttestationBadgeProps> = ({
  provider,
  verified,
  onView,
}) => {
  const label = verified ? `${provider} verified` : `${provider} unverified`;
  const inner = (
    <Badge
      tone={verified ? 'success' : 'warning'}
      icon={<span aria-hidden>🛡️</span>}
    >
      {label}
    </Badge>
  );
  if (!onView) return inner;
  return (
    <button type="button" onClick={onView} className="cursor-pointer">
      {inner}
    </button>
  );
};

// ---------- EarningsReceipt -------------------------------------------------
// The "holy shit" moment: the seller sees their first inflow as a receipt
// row, not a dashboard chart. Gstack: show your work — receipts beat charts.

export interface EarningsReceiptProps {
  amount: string;            // "0.01"
  currency?: string;         // "USDC"
  agentAddress: string;
  agentVerified?: boolean;
  /** ISO timestamp; rendered relative if within 24h, absolute otherwise. */
  at: string;
  /** Optional explorer link (Etherscan / Basescan tx). */
  txUrl?: string;
}

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const delta = Math.max(0, Date.now() - t);
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export const EarningsReceipt: React.FC<EarningsReceiptProps> = ({
  amount,
  currency = 'USDC',
  agentAddress,
  agentVerified,
  at,
  txUrl,
}) => (
  <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2 text-sm">
    <div className="flex items-center gap-2">
      <span className="font-semibold text-secondary">+{amount} {currency}</span>
      <span className="text-text-muted">from</span>
      <AgentIdBadge agentAddress={agentAddress} verified={agentVerified} />
    </div>
    <div className="flex items-center gap-2 text-xs text-text-muted">
      <span>{relativeTime(at)}</span>
      {txUrl && (
        <a
          href={txUrl}
          target="_blank"
          rel="noreferrer"
          className="text-primary hover:underline"
        >
          tx ↗
        </a>
      )}
    </div>
  </div>
);

// ---------- BottomNav -------------------------------------------------------

export interface BottomNavItem {
  key: string;
  label: string;
  icon: React.ReactNode;
  href: string;
}

export interface BottomNavProps {
  items: BottomNavItem[];
  activeKey?: string;
  /** Render prop so callers can plug Next.js `<Link>` without coupling this package to next/link. */
  renderLink?: (item: BottomNavItem, children: React.ReactNode) => React.ReactNode;
}

export const BottomNav: React.FC<BottomNavProps> = ({ items, activeKey, renderLink }) => (
  <nav
    aria-label="Primary"
    className={cn(
      'fixed inset-x-0 bottom-0 z-40 flex h-nav-height-mobile items-center justify-around',
      'border-t border-border bg-surface/80 backdrop-blur',
      'sm:h-nav-height',
      'pb-[env(safe-area-inset-bottom)]',
    )}
  >
    {items.map((item) => {
      const active = item.key === activeKey;
      const inner = (
        <span
          className={cn(
            'flex flex-col items-center gap-0.5 text-xs',
            active ? 'text-primary' : 'text-text-muted',
          )}
        >
          <span aria-hidden className="h-5 w-5">
            {item.icon}
          </span>
          {item.label}
        </span>
      );
      const link = renderLink ? renderLink(item, inner) : <a href={item.href}>{inner}</a>;
      return (
        <span key={item.key} className="flex-1 text-center">
          {link}
        </span>
      );
    })}
  </nav>
);
