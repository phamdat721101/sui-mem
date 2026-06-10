'use client';

/**
 * lib/sui.tsx — Sui dapp-kit configuration + provider wrapper.
 *
 * Single place where Sui chain endpoints + the dapp-kit `<SuiClientProvider>`
 * network registry are declared. Adding mainnet later = one entry below.
 *
 * SOLID:
 *  - SRP: chain config + the React provider tuple. No hooks, no DOM.
 *  - DIP: callers consume `<SuiProviders>` — the underlying dapp-kit tuple
 *    is an implementation detail.
 *  - OCP: a new Sui chain (e.g. mainnet, devnet) = one entry in `networks`.
 */

import { SuiClientProvider, WalletProvider } from '@mysten/dapp-kit';
import { getFullnodeUrl } from '@mysten/sui/client';
import type { ReactNode } from 'react';
import '@mysten/dapp-kit/dist/index.css';

/** Named Sui chains exposed via dapp-kit's `useSuiClientContext()`. */
export const SUI_NETWORKS = {
  testnet: { url: getFullnodeUrl('testnet') },
  // Mainnet stubbed for forward compatibility; not yet wired into the
  // network switcher UI per the testnet-first decision in the PRD.
  mainnet: { url: getFullnodeUrl('mainnet') },
} as const;

export type SuiNetworkName = keyof typeof SUI_NETWORKS;

export const DEFAULT_SUI_NETWORK: SuiNetworkName = 'testnet';

/**
 * Wraps children with the dapp-kit Sui providers.
 *
 * Order is significant — `WalletProvider` must be *inside* `SuiClientProvider`
 * because the wallet adapters depend on a configured `SuiClient` to broadcast
 * transactions.
 *
 * `autoConnect` re-uses the last selected wallet on page reload — desirable
 * UX and free since dapp-kit owns the persistence.
 */
export function SuiProviders({ children }: { children: ReactNode }) {
  return (
    <SuiClientProvider networks={SUI_NETWORKS} defaultNetwork={DEFAULT_SUI_NETWORK}>
      <WalletProvider autoConnect>{children}</WalletProvider>
    </SuiClientProvider>
  );
}
