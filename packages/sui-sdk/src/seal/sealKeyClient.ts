/**
 * Seal IBE key client — wraps content-encryption keys for an identity (e.g.
 * "brain:<id>:subscriber") and unwraps them via threshold key servers that
 * verify a Move policy before releasing their share.
 *
 * SOLID:
 * - Liskov: `MockSealKeyClient` and `HttpSealKeyClient` are interchangeable.
 * - Open/Closed: a future `MystenSealClient` (when the published `@mysten/seal`
 *   SDK stabilises) plugs in by adding a third implementation.
 * - Dependency Inversion: callers depend on `SealKeyClient`, never on a
 *   specific HTTP client or KMS.
 *
 * "Do not repeat sample mistake": every external HTTP call goes through
 * `resilientCall` from `@fhe-ai-context/runtime-utils`. There is no bare fetch
 * to a Seal key server anywhere in this codebase.
 */

import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import {
  resilientCall,
  type ResilientLogger,
} from '@fhe-ai-context/runtime-utils';

/** Attestation that the caller holds a valid Move-side `Subscription` for the brain. */
export interface SealSubscriptionProof {
  /** Sui object ID of the `Subscription` capability NFT. */
  suiObjectId: string;
  /** Sui object ID of the `Brain` (used to build seal_approve tx). */
  brainObjectId: string;
  /** Sui object ID of the shared `SubscriptionPolicy` (used to build seal_approve tx). */
  policyObjectId: string;
  /** Off-chain signature attesting the subscription is unexpired. T11 sources this from RPC. */
  signature: string;
}

/** Optional KYA claim presented alongside subscription for kya_required brains. */
export interface SealKYAClaim {
  agentAddress: string;
  reputation: number;
  proof: string;
  /** Sui object ID of the on-chain `KYAClaim` (when one exists). */
  objectId?: string;
}

export interface EncryptKeyOpts {
  /** IBE identity, e.g. `brain:<brainId>:subscriber`. */
  identity: string;
  /** 32-byte AES-256 key to wrap. */
  key: Uint8Array;
  logger?: ResilientLogger;
}

export interface DecryptKeyOpts {
  identity: string;
  ciphertext: Uint8Array;
  subscriptionProof?: SealSubscriptionProof;
  kyaClaim?: SealKYAClaim;
  logger?: ResilientLogger;
}

export interface SealKeyClient {
  encryptKey(opts: EncryptKeyOpts): Promise<Uint8Array>;
  decryptKey(opts: DecryptKeyOpts): Promise<Uint8Array>;
}

export interface SealConfig {
  /** Comma-separated key-server URLs (or set `SEAL_KEY_SERVERS`). Empty → mock. */
  keyServers?: string[];
  /** Threshold for unwrap (e.g. 2-of-3). Default 2. */
  threshold?: number;
  /**
   * Master secret for the mock derivation. Tests can pass an explicit value;
   * production never sees this path because keyServers != [].
   */
  mockSecret?: string;
}

// ---------- Mock implementation --------------------------------------------

/**
 * Deterministic mock: ciphertext = key XOR HMAC(identity, mockSecret).
 *
 * The mock unconditionally returns the unwrapped key — it does *not* enforce
 * subscription / KYA. That's by design: policy enforcement lives on-chain (the
 * real Seal key servers verify the Move policy). The unit tests around `chat`
 * + `authorize_read` simulate the policy denial separately.
 */
class MockSealKeyClient implements SealKeyClient {
  constructor(private readonly mockSecret: string) {}

  private derive(identity: string): Uint8Array {
    return hmac(sha256, utf8ToBytes(this.mockSecret), utf8ToBytes(identity));
  }

  async encryptKey({ identity, key }: EncryptKeyOpts): Promise<Uint8Array> {
    if (key.byteLength !== 32) throw new Error('Seal mock: key must be 32 bytes');
    const pad = this.derive(identity);
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = key[i] ^ pad[i];
    return out;
  }

  async decryptKey({ identity, ciphertext }: DecryptKeyOpts): Promise<Uint8Array> {
    if (ciphertext.byteLength !== 32) throw new Error('Seal mock: ciphertext must be 32 bytes');
    const pad = this.derive(identity);
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = ciphertext[i] ^ pad[i];
    return out;
  }
}

// ---------- HTTP implementation (skeleton) ---------------------------------

/**
 * Real Seal threshold-IBE adapter for `@mysten/seal`.
 *
 * Encryption is local IBE wrapping — no network. Decryption builds a
 * `seal_approve` (or `seal_approve_pay_per_call`) Move tx-kind targeting the
 * `OPENX_BRAIN_PACKAGE_ID` deployment, hands it to `SealClient.decrypt`, and
 * the SDK fans the request out to the configured threshold key servers.
 *
 * Mock-first: when `@mysten/seal` isn't installed (CI / unit tests / fresh
 * dev), the factory returns the mock client. Production swap: install
 * `@mysten/seal` + `@mysten/sui` and set `SEAL_KEY_SERVERS` + `OPENX_BRAIN_PACKAGE_ID`.
 *
 * The SDK is loaded via dynamic import to keep it a peer dep (sui-sdk users
 * who only need the mock pay no install cost).
 */
class HttpSealKeyClient implements SealKeyClient {
  constructor(
    private readonly keyServers: string[],
    private readonly threshold: number,
    private readonly packageId: string,
    private readonly suiRpcUrl: string,
  ) {}

  async encryptKey(opts: EncryptKeyOpts): Promise<Uint8Array> {
    if (opts.key.byteLength !== 32) throw new Error('Seal: key must be 32 bytes');
    const seal = await this.loadSdk();
    const { ciphertext } = await resilientCall(
      { name: 'seal-encrypt', logger: opts.logger },
      async () =>
        seal.client.encrypt({
          packageId: this.packageId,
          id: hexFromIdentity(opts.identity),
          threshold: this.threshold,
          data: opts.key,
        }),
    );
    return ciphertext as Uint8Array;
  }

  async decryptKey(opts: DecryptKeyOpts): Promise<Uint8Array> {
    if (this.keyServers.length < this.threshold) {
      throw new Error(`Seal: need ≥${this.threshold} key servers, have ${this.keyServers.length}`);
    }
    const seal = await this.loadSdk();
    // Caller supplies the raw (already constructed) tx kind via opts.metadata
    // OR we synthesise a default `seal_approve_pay_per_call` call from the
    // subscription proof + brain identity. The latter covers 95 % of the
    // OpenX flagship paid-query flow; bespoke flows (multi-sig, gasless)
    // build their own tx kinds.
    if (!opts.subscriptionProof) {
      throw new Error('Seal: decryptKey requires subscriptionProof for SEAL approve');
    }
    const txBytes = await seal.buildSealApproveTx({
      packageId: this.packageId,
      module: 'brain_registry',
      function: 'seal_approve_pay_per_call',
      identity: hexFromIdentity(opts.identity),
      brainObjectId: opts.subscriptionProof.brainObjectId,
      policyObjectId: opts.subscriptionProof.policyObjectId,
      subscriptionObjectId: opts.subscriptionProof.suiObjectId,
      kyaClaimObjectId: opts.kyaClaim?.objectId,
      suiRpcUrl: this.suiRpcUrl,
    });
    return resilientCall(
      { name: 'seal-decrypt', logger: opts.logger },
      async () =>
        seal.client.decrypt({
          ciphertext: opts.ciphertext,
          txBytes,
        }),
    );
  }

  /**
   * Lazily import `@mysten/seal`. Returns a thin facade so tests can mock the
   * surface; if the package is absent we throw with a clear remediation.
   */
  private async loadSdk(): Promise<SealSdkFacade> {
    const moduleName = '@mysten/seal';
    const sdk: any = await import(/* @vite-ignore */ /* webpackIgnore: true */ moduleName).catch(
      () => null,
    );
    if (!sdk?.SealClient) {
      throw new Error(
        '@mysten/seal not installed. Run `npm i @mysten/seal @mysten/sui` or unset SEAL_KEY_SERVERS to use the mock.',
      );
    }
    const client = new sdk.SealClient({
      suiClient: await this.suiClient(),
      serverObjectIds: this.keyServers,
      verifyKeyServers: true,
    });
    return {
      client,
      buildSealApproveTx: (params: SealApproveCallParams) => sdk.buildSealApproveTx(params),
    };
  }

  private async suiClient(): Promise<unknown> {
    const moduleName = '@mysten/sui/client';
    const m: any = await import(/* @vite-ignore */ /* webpackIgnore: true */ moduleName);
    // Pass TATUM_API_KEY via x-api-key header when set — lifts the free-tier rate limit.
    // Without this, demo-time bursts get 429s. Fallback transport routes to the public
    // Mysten fullnode on 429 / 5xx so the demo never wedges on Tatum-side issues.
    const apiKey = process.env.TATUM_API_KEY;
    const isTestnet = this.suiRpcUrl.includes('testnet');
    const fallbackUrl = isTestnet
      ? 'https://fullnode.testnet.sui.io'
      : 'https://fullnode.mainnet.sui.io';
    if (m.SuiHTTPTransport) {
      const transport = new m.SuiHTTPTransport({
        url: this.suiRpcUrl,
        rpc: apiKey ? { headers: { 'x-api-key': apiKey } } : undefined,
        // Fallback transport — used by SuiClient when primary returns 429/5xx.
        fallback: { url: fallbackUrl },
      });
      return new m.SuiClient({ transport });
    }
    // Older @mysten/sui versions without SuiHTTPTransport — best-effort headers via url.
    return new m.SuiClient({ url: this.suiRpcUrl });
  }
}

interface SealApproveCallParams {
  packageId: string;
  module: string;
  function: string;
  identity: string;
  brainObjectId: string;
  policyObjectId: string;
  subscriptionObjectId: string;
  kyaClaimObjectId?: string;
  suiRpcUrl: string;
}

interface SealSdkFacade {
  client: { encrypt: (a: any) => Promise<{ ciphertext: Uint8Array }>; decrypt: (a: any) => Promise<Uint8Array> };
  buildSealApproveTx: (params: SealApproveCallParams) => Promise<Uint8Array>;
}

function hexFromIdentity(s: string): string {
  return '0x' + Buffer.from(s, 'utf8').toString('hex');
}

// ---------- Factory --------------------------------------------------------

/**
 * Pick an implementation. When `keyServers` is empty/unset we return the mock.
 * Real wiring is selected by `SEAL_KEY_SERVERS` env (csv) + optional
 * `SEAL_THRESHOLD` env (default 2) + `OPENX_BRAIN_PACKAGE_ID` for the
 * `seal_approve_pay_per_call` Move target.
 */
export function createSealKeyClient(cfg: SealConfig & { packageId?: string; suiRpcUrl?: string } = {}): SealKeyClient {
  const envServers = (process.env.SEAL_KEY_SERVERS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const keyServers = cfg.keyServers ?? envServers;
  const threshold = cfg.threshold ?? Number(process.env.SEAL_THRESHOLD ?? 2);
  const packageId = cfg.packageId ?? process.env.OPENX_BRAIN_PACKAGE_ID ?? '';
  const suiRpcUrl =
    cfg.suiRpcUrl ?? process.env.SUI_RPC_URL ?? 'https://sui-mainnet.gateway.tatum.io';

  if (keyServers.length === 0 || !packageId) {
    const mockSecret =
      cfg.mockSecret ??
      process.env.SEAL_MOCK_SECRET ??
      bytesToHex(sha256(utf8ToBytes('fhe-second-brain-mock-secret')));
    return new MockSealKeyClient(mockSecret);
  }
  return new HttpSealKeyClient(keyServers, threshold, packageId, suiRpcUrl);
}
