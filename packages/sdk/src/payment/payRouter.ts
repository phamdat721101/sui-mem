/**
 * payRouter — unified `Pay()` abstraction across the OpenX rails.
 *
 * Sui-only after the EVM/Fhenix pivot:
 *   - `sui_usdc` — Programmable transaction calling
 *     `subscription_policy::subscribe<USDC>` on the OpenX Move package
 *   - `x402` — HTTP 402 settled in Sui-USDC via `n-payment` (Sui chain)
 *   - `mpp` — Tempo Multi-Payment Protocol (chain-agnostic)
 *
 * SOLID:
 *   - `RailAdapter` is the only behaviour interface (ISP).
 *   - `PayRouter` is a thin dispatcher (SRP).
 *   - Each adapter is mock-first; real-prod swap = replace pay() body.
 *   - parse402 is a pure function (no I/O) so it composes everywhere.
 */

export type Rail = 'x402' | 'mpp' | 'sui_usdc';

export interface RailOffer {
  rail: Rail;
  method: string;          // 'exact' (x402) | 'tempo' (mpp) | 'sui-usdc'
  amount_usdc: string;     // decimal string ("0.01")
  metadata: Record<string, string>;
}

export interface PaymentChallenge {
  rails: RailOffer[];
  endpoint_url: string;
  challenge_id?: string;
}

export interface PaymentReceipt {
  rail: Rail;
  tx_or_receipt: string;
  amount_usdc: string;
  ts: number;
  mock?: boolean;
}

export interface PayOptions {
  walletAddress: string;
  /** Dev-only signer; production callers pass a wallet adapter instead. */
  privateKey?: string;
  /** MPP secret key handle (KMS-backed in prod). */
  mppSecretKeyId?: string;
}

export interface WalletPrefs {
  preferredRail?: Rail;
  hasSuiWallet?: boolean;
  hasMppFunds?: boolean;
}

export interface RailAdapter {
  readonly rail: Rail;
  pay(offer: RailOffer, ctx: { challenge: PaymentChallenge; opts: PayOptions }): Promise<PaymentReceipt>;
}

// ---------- Parser --------------------------------------------------------

/** Parse the WWW-Authenticate headers of a 402 response. Returns rails:[] on no match. */
export function parse402(response: { headers: Headers; url: string; status: number }): PaymentChallenge | null {
  if (response.status !== 402) return null;
  const raw = response.headers.get('www-authenticate') ?? '';
  const parts = raw.split(/,\s*(?=Payment\b)/g).filter((p) => p.startsWith('Payment'));
  const rails: RailOffer[] = [];
  for (const part of parts) {
    const params = parseAuthParams(part);
    const rail = methodToRail(params.method);
    if (!rail) continue;
    rails.push({
      rail,
      method: params.method ?? '',
      amount_usdc: params.amount ?? '0',
      metadata: params,
    });
  }
  return { rails, endpoint_url: response.url, challenge_id: rails[0]?.metadata.id };
}

function parseAuthParams(headerSegment: string): Record<string, string> {
  const out: Record<string, string> = {};
  const body = headerSegment.replace(/^Payment\s*/, '');
  const re = /(\w+)\s*=\s*("([^"]*)"|([^,]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    out[m[1]] = (m[3] ?? m[4] ?? '').trim();
  }
  return out;
}

function methodToRail(method?: string): Rail | null {
  if (!method) return null;
  const m = method.toLowerCase();
  if (m === 'x402' || m === 'exact') return 'x402';
  if (m === 'tempo' || m === 'mpp') return 'mpp';
  if (m === 'sui-usdc' || m === 'sui_usdc') return 'sui_usdc';
  return null;
}

// ---------- Mock-first adapters -------------------------------------------

const mockReceipt = (rail: Rail, offer: RailOffer): PaymentReceipt => ({
  rail,
  tx_or_receipt: `mock-${rail}-${Date.now().toString(16)}`,
  amount_usdc: offer.amount_usdc,
  ts: Date.now(),
  mock: true,
});

export const x402Adapter: RailAdapter = {
  rail: 'x402',
  async pay(offer, { challenge, opts }): Promise<PaymentReceipt> {
    try {
      const moduleName = 'n-payment';
      const np: any = await import(/* @vite-ignore */ /* webpackIgnore: true */ moduleName).catch(() => null);
      if (np?.createPaymentClient && opts.privateKey) {
        const client = np.createPaymentClient({
          // x402 on Sui — defaults to mainnet; agent.chain overrides per call.
          chains: [offer.metadata.network ?? 'sui-mainnet'],
          wallet: { privateKey: opts.privateKey },
        });
        const r = await client.fetchWithPayment(challenge.endpoint_url);
        const txHash = r.headers?.get?.('X-PAYMENT-RESPONSE') ?? `np-${Date.now().toString(16)}`;
        return { rail: 'x402', tx_or_receipt: txHash, amount_usdc: offer.amount_usdc, ts: Date.now() };
      }
    } catch {/* fall through to mock */}
    return mockReceipt('x402', offer);
  },
};

export const mppAdapter: RailAdapter = {
  rail: 'mpp',
  async pay(offer) {
    return mockReceipt('mpp', offer);
  },
};

export const suiUsdcAdapter: RailAdapter = {
  rail: 'sui_usdc',
  async pay(offer): Promise<PaymentReceipt> {
    try {
      const [client, tx, kp] = await Promise.all([
        import(/* @vite-ignore */ /* webpackIgnore: true */ '@mysten/sui/client').catch(() => null),
        import(/* @vite-ignore */ /* webpackIgnore: true */ '@mysten/sui/transactions').catch(() => null),
        import(/* @vite-ignore */ /* webpackIgnore: true */ '@mysten/sui/keypairs/ed25519').catch(() => null),
      ]);
      const packageId = process.env.OPENX_BRAIN_PACKAGE_ID;
      const policyId = offer.metadata.policy_object_id;
      const usdcCoinType = process.env.OPENX_USDC_COIN_TYPE;
      const privateKey = (offer.metadata.private_key ?? process.env.SUI_PAYER_PRIVATE_KEY) as string | undefined;
      if (!client || !tx || !kp || !packageId || !policyId || !usdcCoinType || !privateKey) {
        return mockReceipt('sui_usdc', offer);
      }
      const suiClient = new (client as any).SuiClient({
        url: process.env.SUI_RPC_URL ?? 'https://fullnode.mainnet.sui.io',
      });
      const keypair = (kp as any).Ed25519Keypair.fromSecretKey(privateKey);
      const txb = new (tx as any).Transaction();
      const [paymentCoin] = offer.metadata.coin_object_id
        ? [txb.object(offer.metadata.coin_object_id)]
        : txb.splitCoins(txb.gas, [txb.pure.u64(BigInt(offer.metadata.price_mist ?? 0))]);
      const sub = txb.moveCall({
        target: `${packageId}::subscription_policy::subscribe`,
        typeArguments: [usdcCoinType],
        arguments: [txb.object(policyId), paymentCoin, txb.object('0x6')],
      });
      txb.transferObjects([sub], txb.pure.address(keypair.toSuiAddress()));
      const result = await suiClient.signAndExecuteTransaction({
        signer: keypair,
        transaction: txb,
        options: { showEffects: true, showObjectChanges: true },
      });
      return {
        rail: 'sui_usdc',
        tx_or_receipt: result.digest,
        amount_usdc: offer.amount_usdc,
        ts: Date.now(),
      };
    } catch {
      return mockReceipt('sui_usdc', offer);
    }
  },
};

// ---------- Router --------------------------------------------------------

export class PayRouter {
  private adapters: Partial<Record<Rail, RailAdapter>>;
  constructor(adapters?: Partial<Record<Rail, RailAdapter>>) {
    this.adapters = {
      x402: adapters?.x402 ?? x402Adapter,
      mpp: adapters?.mpp ?? mppAdapter,
      sui_usdc: adapters?.sui_usdc ?? suiUsdcAdapter,
    };
  }

  /** Pick the best available rail. Defaults to sui_usdc on Sui-only deployments. */
  selectRail(challenge: PaymentChallenge, prefs: WalletPrefs = {}): Rail {
    if (challenge.rails.length === 0) throw new Error('payRouter:no-rails-offered');
    if (prefs.preferredRail && challenge.rails.some((r) => r.rail === prefs.preferredRail)) {
      return prefs.preferredRail;
    }
    const capable = challenge.rails.filter((r) => this.walletCanUse(r.rail, prefs));
    const ranked = (capable.length ? capable : challenge.rails)
      .slice()
      .sort((a, b) => Number(a.amount_usdc) - Number(b.amount_usdc));
    return ranked[0].rail;
  }

  async pay(challenge: PaymentChallenge, rail: Rail, opts: PayOptions): Promise<PaymentReceipt> {
    const offer = challenge.rails.find((r) => r.rail === rail);
    if (!offer) throw new Error(`payRouter:rail-not-offered:${rail}`);
    const adapter = this.adapters[rail];
    if (!adapter) throw new Error(`payRouter:adapter-not-registered:${rail}`);
    return adapter.pay(offer, { challenge, opts });
  }

  private walletCanUse(rail: Rail, prefs: WalletPrefs): boolean {
    if (rail === 'sui_usdc') return prefs.hasSuiWallet ?? true;
    if (rail === 'x402') return prefs.hasSuiWallet ?? true; // Sui-USDC settles x402 too
    if (rail === 'mpp') return prefs.hasMppFunds ?? prefs.hasSuiWallet ?? true;
    return false;
  }
}
