'use client';

/**
 * SuiWalletButton — top-bar Sui wallet connect/disconnect pill.
 *
 * SOLID:
 *  - SRP: connect/disconnect + truncated address display. Nothing else.
 *  - DIP: dapp-kit's hooks are the only Sui surface this file touches.
 */

import {
  useCurrentAccount,
  useCurrentWallet,
  useDisconnectWallet,
  useConnectWallet,
  useWallets,
} from '@mysten/dapp-kit';

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function SuiWalletButton() {
  const current = useCurrentWallet();
  const account = useCurrentAccount();
  const wallets = useWallets();
  const { mutate: connect, isPending: connecting } = useConnectWallet();
  const { mutate: disconnect } = useDisconnectWallet();

  if (current.connectionStatus === 'connected' && account) {
    return (
      <button
        type="button"
        onClick={() => disconnect()}
        title={account.address}
        className="flex items-center gap-1.5 rounded-full border border-outline-variant/40 bg-surface-container-high px-3 py-1.5 text-xs font-mono text-on-surface hover:border-error/40 hover:text-error"
      >
        <span aria-hidden>🟣</span>
        <span>{shortAddr(account.address)}</span>
        <span className="material-symbols-outlined text-[14px] opacity-60">logout</span>
      </button>
    );
  }

  const noWallets = wallets.length === 0;

  return (
    <button
      type="button"
      onClick={() => {
        if (noWallets) return;
        connect({ wallet: wallets[0] });
      }}
      disabled={connecting || noWallets}
      title={
        noWallets
          ? 'Install Slush, Suiet, or another Sui wallet to continue'
          : 'Connect Sui wallet'
      }
      className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-mono transition-colors ${
        connecting || noWallets
          ? 'cursor-not-allowed border-outline-variant/20 bg-surface-container-low text-on-surface-variant/60'
          : 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/20'
      }`}
    >
      <span aria-hidden>🟣</span>
      <span>{noWallets ? 'No Sui wallet' : connecting ? 'Connecting…' : 'Connect Sui'}</span>
    </button>
  );
}
