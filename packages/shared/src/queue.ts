import { Queue, Worker, Processor } from 'bullmq';

const connection = { url: process.env.REDIS_URL || 'redis://localhost:6379' };

export const QUEUE_NAMES = {
  IPFS_PIN: 'ipfs-pin',
  FILE_PROCESS: 'file-process',
  CHAIN_SYNC: 'chain-sync',
  HISTORY_ARCHIVE: 'history-archive',
} as const;

/** Create a BullMQ queue by name. */
export function createQueue(name: string) {
  return new Queue(name, { connection });
}

/** Create a BullMQ worker for a named queue. */
export function createWorker<T = unknown>(name: string, processor: Processor<T>) {
  return new Worker<T>(name, processor, { connection });
}
