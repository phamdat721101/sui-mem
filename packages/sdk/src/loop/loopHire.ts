/**
 * loop/loopHire — Mode B hire PTB builder.
 *
 * Returns a `Transaction` calling `openx_loop_job_factory::create<USDC>` —
 * the buyer's `Coin<USDC>` is consumed exactly; the factory spawns + shares
 * a `LoopJob<USDC>` shared object inside the same tx.
 */

import { Transaction } from '@mysten/sui/transactions';

export interface BuildHireArgs {
  packageId: string;
  agentObjectId: string;
  maxIterations: number;
  budgetCoinObjectId: string;
  usdcCoinType: string;
  clockObjectId?: string;
}

export function buildCreateJobPtb(args: BuildHireArgs): Transaction {
  if (args.maxIterations < 1 || args.maxIterations > 50) {
    throw new Error('loop:hire: maxIterations must be in [1, 50]');
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${args.packageId}::openx_loop_job_factory::create`,
    typeArguments: [args.usdcCoinType],
    arguments: [
      tx.object(args.agentObjectId),
      tx.pure.u64(BigInt(args.maxIterations)),
      tx.object(args.budgetCoinObjectId),
      tx.object(args.clockObjectId ?? '0x6'),
    ],
  });
  return tx;
}
