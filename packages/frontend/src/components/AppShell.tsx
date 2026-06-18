'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCurrentAccount } from '@mysten/dapp-kit';
import { SuiWalletButton } from './SuiWalletButton';

/**
 * AppShell — sticky desktop header + mobile bottom nav.
 *
 * SOLID:
 *  - SRP: chrome only. No data fetching, no wallet logic beyond delegating to
 *    `<SuiWalletButton/>`.
 *  - OCP: a new global destination = one entry in NAV_ITEMS.
 *  - Auth: connecting a Sui wallet IS the auth (no Privy / FHE permits).
 *    Seller-surface entries (`requiresWallet: true`) are hidden until
 *    `useCurrentAccount()` returns an address — keeps the IA honest.
 */

interface NavItem {
  href: string;
  icon: string;
  label: string;
  requiresWallet?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { href: '/', icon: 'home', label: 'Home' },
  { href: '/marketplace', icon: 'storefront', label: 'Marketplace' },
  { href: '/activity', icon: 'receipt_long', label: 'Activity', requiresWallet: true },
  { href: '/studio', icon: 'science', label: 'Studio', requiresWallet: true },
  { href: '/settings', icon: 'tune', label: 'Settings', requiresWallet: true },
];

function isActive(pathname: string, href: string) {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const account = useCurrentAccount();
  const items = NAV_ITEMS.filter((i) => !i.requiresWallet || !!account);

  return (
    <div className="min-h-screen bg-background text-on-surface">
      {/* Sticky top header */}
      <header className="sticky top-0 z-40 border-b border-outline-variant/30 bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 md:px-8">
          <Link href="/" className="flex items-center gap-2">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="shrink-0">
              <path d="M12 3L4 7L12 11L20 7L12 3Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-primary" />
              <path d="M4 17L12 21L20 17" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-primary" />
              <path d="M4 12L12 16L20 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-primary" />
            </svg>
            <span className="font-headline text-lg font-bold tracking-tight text-primary-text">
              OpenX
            </span>
          </Link>

          <nav className="hidden items-center gap-1 md:flex">
            {items.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm transition-colors ${
                    active
                      ? 'bg-surface-container-high text-primary'
                      : 'text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface'
                  }`}
                >
                  <span className="material-symbols-outlined text-[18px]">{item.icon}</span>
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <SuiWalletButton />
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 pb-24 pt-6 md:px-8 md:pb-12">{children}</main>

      {/* Mobile bottom nav */}
      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-outline-variant/30 bg-background/95 backdrop-blur md:hidden">
        <ul className="mx-auto flex max-w-md items-stretch">
          {items.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <li key={item.href} className="flex-1">
                <Link
                  href={item.href}
                  className={`flex h-16 flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors ${
                    active ? 'text-primary' : 'text-on-surface-variant'
                  }`}
                >
                  <span
                    className="material-symbols-outlined text-[22px]"
                    style={active ? { fontVariationSettings: "'FILL' 1" } : undefined}
                  >
                    {item.icon}
                  </span>
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
