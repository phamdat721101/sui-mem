'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SuiProviders } from '@/lib/sui';

const queryClient = new QueryClient();

/**
 * Provider stack — Sui-only after the EVM/Fhenix pivot.
 *
 *   QueryClientProvider — shared by dapp-kit + any react-query consumers
 *     SuiProviders     — Sui RPC + dapp-kit wallet adapters
 *       {children}
 */
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <SuiProviders>{children}</SuiProviders>
    </QueryClientProvider>
  );
}
