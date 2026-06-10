'use client';

import { useEffect, useState } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit';
import { api, type SellerProfile } from '@/lib/api';

/**
 * /settings — connected wallet + seller profile.
 *
 *   • Wallet card — read-only: address + Suiscan link.
 *   • Profile card — display_name, bio, contact_email, support_url.
 *     PATCH /v3/marketplace/seller/me on save (server upserts the row).
 *
 * SOLID:
 *  - SRP: this file owns the form state. No business rules — server validates.
 *  - DIP: depends on `api.sellerMe` + `api.updateSellerProfile`.
 */

export default function SettingsPage() {
  const account = useCurrentAccount();
  if (!account) return <ConnectGate />;
  return <Settings wallet={account.address} />;
}

function Settings({ wallet }: { wallet: string }) {
  const [profile, setProfile] = useState<SellerProfile | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [form, setForm] = useState({ display_name: '', bio: '', contact_email: '', support_url: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    api.sellerMe(wallet)
      .then((r) => {
        setProfile(r.seller);
        setForm({
          display_name: r.seller?.display_name ?? '',
          bio: r.seller?.bio ?? '',
          contact_email: r.seller?.contact_email ?? '',
          support_url: r.seller?.support_url ?? '',
        });
      })
      .finally(() => setLoaded(true));
  }, [wallet]);

  async function save() {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.updateSellerProfile(wallet, form);
      setMsg({ kind: 'ok', text: 'Profile saved.' });
    } catch (e: any) {
      setMsg({ kind: 'err', text: String(e?.message ?? e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="font-headline text-3xl font-bold">Settings</h1>

      <section className="space-y-3 rounded-xl border border-outline-variant/30 bg-surface p-6">
        <div className="flex items-center gap-2 text-on-surface-variant">
          <span className="material-symbols-outlined text-[18px] text-primary">account_circle</span>
          <span className="font-mono text-xs uppercase tracking-wider">connected wallet</span>
        </div>
        <div className="break-all font-mono text-sm">{wallet}</div>
        <div className="flex items-center gap-3 text-xs">
          <a
            href={`https://suiscan.xyz/testnet/account/${wallet}`}
            target="_blank"
            rel="noreferrer"
            className="text-primary hover:underline"
          >
            View on Suiscan ↗
          </a>
          <span className="text-on-surface-variant">
            Your Sui wallet is your only auth credential — no API keys.
          </span>
        </div>
      </section>

      <section className="space-y-4 rounded-xl border border-outline-variant/30 bg-surface p-6">
        <div className="flex items-center justify-between">
          <h2 className="font-headline text-lg font-bold">Seller profile</h2>
          {profile && (
            <span className="rounded-full border border-secondary/30 bg-secondary/10 px-2 py-0.5 font-mono text-[10px] text-secondary">
              seller #{profile.id}
            </span>
          )}
        </div>
        {!loaded ? (
          <p className="text-sm text-on-surface-variant">Loading profile…</p>
        ) : (
          <>
            <Field label="Display name">
              <input
                value={form.display_name}
                onChange={(e) => setForm((s) => ({ ...s, display_name: e.target.value }))}
                placeholder={wallet.slice(0, 6) + '…' + wallet.slice(-4)}
                className={inputCx}
              />
            </Field>
            <Field label="Bio">
              <textarea
                value={form.bio}
                onChange={(e) => setForm((s) => ({ ...s, bio: e.target.value }))}
                rows={3}
                className={inputCx}
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Contact email">
                <input
                  type="email"
                  value={form.contact_email}
                  onChange={(e) => setForm((s) => ({ ...s, contact_email: e.target.value }))}
                  className={inputCx}
                />
              </Field>
              <Field label="Support URL">
                <input
                  type="url"
                  value={form.support_url}
                  onChange={(e) => setForm((s) => ({ ...s, support_url: e.target.value }))}
                  placeholder="https://"
                  className={inputCx}
                />
              </Field>
            </div>
            {msg && (
              <div
                className={`rounded-lg border px-3 py-2 text-sm ${
                  msg.kind === 'ok'
                    ? 'border-secondary/30 bg-secondary/10 text-secondary'
                    : 'border-error/30 bg-error/10 text-error'
                }`}
              >
                {msg.text}
              </div>
            )}
            <div className="flex justify-end border-t border-outline-variant/20 pt-3">
              <button
                type="button"
                onClick={save}
                disabled={busy}
                className="rounded-full bg-primary px-5 py-2 text-sm font-medium text-on-primary disabled:opacity-50"
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

const inputCx =
  'w-full rounded-lg border border-outline-variant/40 bg-surface-container-low px-3 py-2 text-sm text-on-surface focus:border-primary/60 focus:outline-none';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-on-surface">{label}</span>
      {children}
    </label>
  );
}

function ConnectGate() {
  return (
    <div className="mx-auto max-w-xl rounded-xl border border-dashed border-outline-variant/40 bg-surface-container-low p-12 text-center">
      <h1 className="font-headline text-2xl font-bold">Connect to view settings</h1>
      <p className="mt-2 text-sm text-on-surface-variant">
        Your Sui wallet is your identity. Connect via the top bar.
      </p>
    </div>
  );
}
