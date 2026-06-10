/**
 * One-shot setup CLI — register the configured delegate hex on the
 * configured MemWalAccount so the OpenX operator pool can sign upstream
 * MemWal calls on the seller's behalf.
 *
 * Idempotent: re-running with an already-registered delegate is a no-op
 * onchain (the Move module silently dedupes).
 *
 * Usage (on VPS, where envs are already in packages/api/.env):
 *   set -a; . packages/api/.env; set +a
 *   MEMWAL_ACCOUNT_ID=0x45d5… npx tsx scripts/setup-memwal-delegate.ts
 *
 * SOLID:
 *   - SRP: one function, one tx.
 *   - DIP: reuses the existing MemWalOperator service. No fork.
 *   - Doesn't read OPENX_MEMWAL_DELEGATE_PRIVATE_KEYS from anywhere new —
 *     the same env that the runtime adapter uses is the source of truth.
 */
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { fromHex } from '@mysten/sui/utils';
import { getMemWalOperator } from '../packages/api/src/services/memwalOperator';

async function main() {
  const accountId = process.env.MEMWAL_ACCOUNT_ID;
  if (!accountId) throw new Error('MEMWAL_ACCOUNT_ID env required');

  const hexCsv = process.env.OPENX_MEMWAL_DELEGATE_PRIVATE_KEYS ?? '';
  const hexes = hexCsv.split(',').map((s) => s.trim()).filter(Boolean);
  if (hexes.length === 0) throw new Error('OPENX_MEMWAL_DELEGATE_PRIVATE_KEYS env required');

  const operator = getMemWalOperator();
  if (!operator) throw new Error('MemWal operator not configured (OPENX_OPERATOR_SUI_PRIVATE_KEY)');

  // Derive delegate pubkey + Sui address from each private key hex.
  // Ed25519Keypair.fromSecretKey accepts the raw 32-byte secret.
  const delegates = hexes.map((hex, i) => {
    const kp = Ed25519Keypair.fromSecretKey(fromHex(hex.replace(/^0x/, '')));
    return {
      delegatePubkeyHex: '0x' + Buffer.from(kp.getPublicKey().toRawBytes()).toString('hex'),
      delegateSuiAddress: kp.toSuiAddress(),
      label: `openx-pool-${i}`,
    };
  });

  console.log(`MemWalAccount: ${accountId}`);
  console.log(`Operator:      ${operator.operatorAddress}`);
  console.log(`Registering ${delegates.length} delegate(s):`);
  for (const d of delegates) {
    console.log(`  · ${d.label} pubkey=${d.delegatePubkeyHex.slice(0, 10)}… addr=${d.delegateSuiAddress}`);
  }

  const result = await operator.addDelegateKeys(accountId, delegates);
  console.log(`\n✓ tx digest: ${result.digest}`);
  console.log(`  (re-run if you add more delegates; existing entries are no-ops)`);
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
