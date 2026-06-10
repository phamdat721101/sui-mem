/**
 * memwalOperator.ts — operator-side Sui calls for the MemWal-tier marketplace.
 *
 * Responsibilities (PRD-11 §6):
 *   1. Provision an OpenX-pool of N delegate keys on a seller's MemWalAccount
 *      via `memwal::account::add_delegate_key`. Default N=5; max 20.
 *   2. Deprovision the pool when a brain is unpublished.
 *   3. Record the on-chain ledger row for a paid query
 *      (`openx::memwal_billing::record_paid_query`).
 *   4. Settle a batch via
 *      `openx::memwal_billing::settle_batch` + revenue_split.distribute<T>.
 *
 * SOLID
 * -----
 *  - SRP: one class — `MemWalOperator`. No HTTP routes; routes wrap it.
 *  - DIP: takes a `SuiClient` + `Ed25519Keypair` in the constructor, never
 *    imports them at module load. The factory `getOperator()` reads env once.
 *  - LSP: every "submit a Sui tx" method returns `{ digest, ts }` — uniform.
 *
 * The operator's Sui wallet is configured via `OPENX_OPERATOR_SUI_PRIVATE_KEY`
 * (modern Bech32 `suiprivkey1…` form). This wallet pays gas for delegate
 * registration + settlement batches. It is NOT the seller's wallet — sellers
 * authorise the OpenX-pool registration with a separate transaction the
 * frontend produces (we never custody seller keys).
 */

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { fromHex } from '@mysten/sui/utils';
import { logger } from '../lib';

export interface MemWalOperatorConfig {
  /** RPC URL — defaults to `getFullnodeUrl('testnet')`. */
  rpcUrl?: string;
  /** OpenX operator wallet (Bech32 suiprivkey1… or hex). Required. */
  operatorPrivateKey: string;
  /** OpenX Move package id (deployed `fhe_brain` package). Required for billing/split calls. */
  packageId: string;
  /** Upstream MemWal package id — required for `add_delegate_key`. */
  memwalPackageId: string;
}

export interface SubmitResult {
  digest: string;
  ts: number;
}

export interface DelegateRegistration {
  delegatePubkeyHex: string;
  delegateSuiAddress: string;
  label: string;
}

export class MemWalOperator {
  private readonly client: SuiClient;
  private readonly signer: Ed25519Keypair;
  private readonly cfg: MemWalOperatorConfig;

  /** Address of the operator wallet. Logged as a fingerprint, never echoed in user-facing responses. */
  readonly operatorAddress: string;

  constructor(cfg: MemWalOperatorConfig) {
    this.cfg = cfg;
    this.client = new SuiClient({ url: cfg.rpcUrl ?? getFullnodeUrl('testnet') });
    this.signer = decodeSignerKey(cfg.operatorPrivateKey);
    this.operatorAddress = this.signer.toSuiAddress();
  }

  // ─── Delegate-pool lifecycle ─────────────────────────────────────

  /**
   * Register `count` Ed25519 keys as delegates on a seller's MemWalAccount.
   * Returns the registrations (caller persists them in `memwal_delegate_keys`).
   *
   * The seller MUST have already given the operator wallet authority to call
   * `add_delegate_key` (either via direct transfer-of-cap or by having the
   * operator submit a sponsored txn with the seller's own signature). For
   * the OpenX-bound mode (default), the simplest path is for the seller to
   * run a one-shot tx that authorises the pool — that tx lives in the
   * frontend `/account/memwal` page and uses dapp-kit's signTransaction.
   *
   * The Move signature on upstream `memwal::account::add_delegate_key` is:
   *   public entry fun add_delegate_key(
   *     account: &mut MemWalAccount,
   *     public_key: vector<u8>,
   *     sui_address: address,
   *     label: vector<u8>,
   *     clock: &Clock,
   *   )
   */
  async addDelegateKeys(
    memwalAccountId: string,
    delegates: DelegateRegistration[],
  ): Promise<SubmitResult> {
    if (delegates.length === 0) throw new Error('addDelegateKeys: empty delegates');
    if (delegates.length > 20) throw new Error('addDelegateKeys: > 20 delegates');

    const tx = new Transaction();
    for (const d of delegates) {
      tx.moveCall({
        target: `${this.cfg.memwalPackageId}::account::add_delegate_key`,
        arguments: [
          tx.object(memwalAccountId),
          tx.pure.vector('u8', Array.from(fromHex(stripHex(d.delegatePubkeyHex)))),
          tx.pure.address(d.delegateSuiAddress),
          tx.pure.vector('u8', Array.from(new TextEncoder().encode(d.label))),
          tx.object('0x6'), // Sui system clock
        ],
      });
    }
    return this.submit(tx, 'addDelegateKeys');
  }

  /** Remove `delegatePubkey` from the seller's MemWalAccount. */
  async removeDelegateKey(
    memwalAccountId: string,
    delegatePubkeyHex: string,
  ): Promise<SubmitResult> {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.cfg.memwalPackageId}::account::remove_delegate_key`,
      arguments: [
        tx.object(memwalAccountId),
        tx.pure.vector('u8', Array.from(fromHex(stripHex(delegatePubkeyHex)))),
      ],
    });
    return this.submit(tx, 'removeDelegateKey');
  }

  // ─── Billing + settlement ────────────────────────────────────────

  /** Emit `PaidQueryRecorded` for one paid query. */
  async recordPaidQuery(args: {
    brainSuiObjectId: string;
    buyer: string;
    amountUsdcMicro: number | bigint;
    attestationHash: string;
    x402TxHash: string;
    rail: string;
  }): Promise<SubmitResult> {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.cfg.packageId}::openx_memwal_billing::record_paid_query`,
      arguments: [
        tx.object(args.brainSuiObjectId),
        tx.pure.address(args.buyer),
        tx.pure.u64(BigInt(args.amountUsdcMicro)),
        tx.pure.vector('u8', Array.from(toBytes(args.attestationHash))),
        tx.pure.vector('u8', Array.from(toBytes(args.x402TxHash))),
        tx.pure.vector('u8', Array.from(new TextEncoder().encode(args.rail))),
        tx.object('0x6'),
      ],
    });
    return this.submit(tx, 'recordPaidQuery');
  }

  /** Emit `SettlementBatchEmitted` after revenue_split runs. */
  async settleBatch(args: {
    brainSuiObjectId: string;
    batchSize: number;
    totalUsdcMicro: number | bigint;
  }): Promise<SubmitResult> {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.cfg.packageId}::openx_memwal_billing::settle_batch`,
      arguments: [
        tx.object(args.brainSuiObjectId),
        tx.pure.u64(BigInt(args.batchSize)),
        tx.pure.u64(BigInt(args.totalUsdcMicro)),
        tx.object('0x6'),
      ],
    });
    return this.submit(tx, 'settleBatch');
  }

  // ─── private ─────────────────────────────────────────────────────

  private async submit(tx: Transaction, label: string): Promise<SubmitResult> {
    const start = Date.now();
    try {
      const out = await this.client.signAndExecuteTransaction({
        signer: this.signer,
        transaction: tx,
        options: { showEffects: true },
      });
      logger.info(
        { op: label, digest: out.digest, ms: Date.now() - start },
        'memwal:operator:submit',
      );
      return { digest: out.digest, ts: Date.now() };
    } catch (e) {
      logger.error(
        { op: label, err: (e as Error)?.message, ms: Date.now() - start },
        'memwal:operator:submit:error',
      );
      throw e;
    }
  }
}

// ─── factory + helpers ───────────────────────────────────────────

let cachedOperator: MemWalOperator | null = null;

export function getMemWalOperator(): MemWalOperator | null {
  if (cachedOperator) return cachedOperator;
  const operatorPrivateKey = process.env.OPENX_OPERATOR_SUI_PRIVATE_KEY;
  const packageId = process.env.OPENX_BRAIN_PACKAGE_ID;
  const memwalPackageId = process.env.MEMWAL_PACKAGE_ID;
  if (!operatorPrivateKey || !packageId || !memwalPackageId) return null;
  const rpcUrl =
    process.env.SUI_TESTNET_RPC_URL ??
    process.env.SUI_RPC_URL ??
    getFullnodeUrl('testnet');
  cachedOperator = new MemWalOperator({
    operatorPrivateKey,
    packageId,
    memwalPackageId,
    rpcUrl,
  });
  return cachedOperator;
}

/** Decode a Sui private key in modern Bech32 form OR raw 32-byte hex. */
function decodeSignerKey(input: string): Ed25519Keypair {
  if (input.startsWith('suiprivkey')) {
    const { schema, secretKey } = decodeSuiPrivateKey(input);
    if (schema !== 'ED25519') {
      throw new Error(`Unsupported Sui key scheme: ${schema}`);
    }
    return Ed25519Keypair.fromSecretKey(secretKey);
  }
  // Raw hex — assume Ed25519.
  return Ed25519Keypair.fromSecretKey(fromHex(stripHex(input)));
}

function stripHex(s: string): string {
  return s.startsWith('0x') ? s.slice(2) : s;
}

function toBytes(hexOrText: string): Uint8Array {
  const s = hexOrText ?? '';
  if (s.startsWith('0x')) return fromHex(s.slice(2));
  // Treat as utf8 if it doesn't look like hex
  return /^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0
    ? fromHex(s)
    : new TextEncoder().encode(s);
}
