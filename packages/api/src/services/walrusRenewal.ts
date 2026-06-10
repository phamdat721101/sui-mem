/**
 * walrusRenewal — periodic Walrus epoch-renewal worker.
 *
 * Walrus blobs expire after ~5 epochs (~10 weeks on mainnet). This service
 * scans the `brains_trustless` index every 6 hours and extends any blob whose
 * `walrus_renewed_until` is within 1 epoch of expiry. Without it, brains
 * silently 404 after ~10 weeks — a category-leadership-blocking bug.
 *
 * SOLID:
 * - SRP: this module only schedules + executes renewal. It does NOT speak
 *   Sui (the Walrus blob extension is itself a Sui tx; the existing
 *   walrusStore ships the call) and does NOT mutate the Sui brain object.
 * - Open/Closed: a future "WalrusRenewer" interface (multi-tenant, KMS-signed
 *   txs) drops in by replacing the inner closure. The cron tick is stable.
 *
 * Mock-first: when WALRUS_PUBLISHER_URL is unset, `extendBlob` is a no-op;
 * the cron still walks the table and updates `walrus_renewed_until` so the
 * surrounding logic stays exercised in dev.
 */

import { pool } from '../db';
import { logger } from '../lib';

/** ~14 days = 1 Walrus epoch on mainnet. */
const ONE_EPOCH_MS = 14 * 24 * 60 * 60 * 1000;
/** Cron tick — every 6 hours. */
const CRON_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Renew brains whose `walrus_renewed_until` falls within this window. */
const RENEWAL_HORIZON_MS = ONE_EPOCH_MS;
/** How long renewal extends each blob — default 5 epochs. */
const EXTENSION_EPOCHS = 5;

let timer: NodeJS.Timeout | null = null;

export function startWalrusRenewalCron(): void {
  if (timer) return;
  // Initial pass on boot, then every 6 hours.
  void runOnce().catch((err) =>
    logger.warn({ err: err.message }, 'walrus-renewal:initial:error'),
  );
  timer = setInterval(() => {
    void runOnce().catch((err) =>
      logger.warn({ err: err.message }, 'walrus-renewal:tick:error'),
    );
  }, CRON_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  logger.info({ intervalMs: CRON_INTERVAL_MS }, 'walrus-renewal:cron:started');
}

export function stopWalrusRenewalCron(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** One renewal sweep — exported for tests / smoke. */
export async function runOnce(): Promise<{ scanned: number; renewed: number }> {
  const horizon = new Date(Date.now() + RENEWAL_HORIZON_MS);
  const r = await pool.query<{
    id: string;
    walrus_blob_ids: string[];
    walrus_renewed_until: Date;
  }>(
    `SELECT id, walrus_blob_ids, walrus_renewed_until
     FROM brains_trustless
     WHERE published = true
       AND walrus_renewed_until <= $1
     ORDER BY walrus_renewed_until ASC
     LIMIT 100`,
    [horizon],
  );
  if (r.rowCount === 0) return { scanned: 0, renewed: 0 };

  let renewed = 0;
  for (const row of r.rows) {
    try {
      await extendBlobs(row.walrus_blob_ids);
      const newUntil = new Date(Date.now() + EXTENSION_EPOCHS * ONE_EPOCH_MS);
      await pool.query(
        `UPDATE brains_trustless SET walrus_renewed_until = $1 WHERE id = $2`,
        [newUntil, row.id],
      );
      renewed++;
    } catch (err) {
      logger.warn({ err: (err as Error).message, brainId: row.id }, 'walrus-renewal:brain:error');
    }
  }
  logger.info({ scanned: r.rowCount, renewed }, 'walrus-renewal:sweep:done');
  return { scanned: r.rowCount, renewed };
}

/**
 * Extend the storage epoch on a list of Walrus blobs.
 *
 * Mock path (no publisher URL): no-op; unit tests verify the cron path
 * without needing a live Walrus.
 *
 * Real path: PUT `/v1/blobs?epochs=…` to the publisher with the existing
 * blob bytes (fetched from the aggregator first). The shape mirrors the
 * existing `WalrusStore.upload` flow, just with the `?epochs=` query.
 */
async function extendBlobs(blobIds: string[]): Promise<void> {
  const publisherUrl = process.env.WALRUS_PUBLISHER_URL;
  const aggregatorUrl = process.env.WALRUS_AGGREGATOR_URL;
  if (!publisherUrl || !aggregatorUrl) return; // dev no-op
  // Path constant kept in one place per file — see walrusStore.ts for the
  // mirror constant; both must move together if Mysten renames again.
  const BLOBS = '/v1/blobs';
  for (const blobId of blobIds) {
    // Two-step: read existing bytes from aggregator, re-PUT to publisher
    // with `?epochs=N`. The publisher recognizes already-stored blobs and
    // only charges for the epoch extension delta.
    const aggRes = await fetch(`${aggregatorUrl}${BLOBS}/${blobId}`);
    if (!aggRes.ok) throw new Error(`walrus-renewal:fetch ${blobId}: ${aggRes.status}`);
    const bytes = new Uint8Array(await aggRes.arrayBuffer());
    const putRes = await fetch(`${publisherUrl}${BLOBS}?epochs=${EXTENSION_EPOCHS}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Blob([bytes as unknown as BlobPart]),
    });
    if (!putRes.ok) throw new Error(`walrus-renewal:extend ${blobId}: ${putRes.status}`);
  }
}
