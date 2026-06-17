/**
 * scripts/backfill-uploads-to-chunks.ts — one-shot backfill.
 *
 * Why: agent_training_events rows with event_type='upload' that predate the
 * Bug B fix in v3-marketplace.ts only carry the file's metadata; the file
 * content was never chunked into knowledge_chunks. The agent's recall path
 * (agentInference.recallFromKnowledgeChunks) therefore can't see them, which
 * is the symptom in train.png ("I'm not finding reliable information about
 * X402 harness in memory in my knowledge base or training data").
 *
 * What this script does, per upload row where chunks_indexed_at IS NULL:
 *   1. Fetch the blob from Walrus via createWalrusStore().
 *   2. Extract text — PDF via getPdfExtractor singleton, text/* + JSON/YAML
 *      via UTF-8 decode, others skipped with reason.
 *   3. Split into 1500-char windows; INSERT into knowledge_chunks.
 *   4. Set chunks_indexed_at = now() so re-runs are no-ops.
 *
 * Idempotent: re-running picks up only rows still NULL.
 * Best-effort: per-row failure does not abort the run.
 *
 * SOLID:
 *   - Reuses the same WalrusStore + PdfExtractor singletons the live route uses.
 *     No parallel implementation, no copy-paste of chunking logic.
 *   - One async function; constructor-injected `pool` via the api package.
 *
 * Run on VPS:
 *   set -a; . /opt/openx/.env; set +a
 *   npx tsx scripts/backfill-uploads-to-chunks.ts [--dry-run] [--limit 50]
 */
import { pool } from '../packages/api/src/db';
import { createWalrusStore } from '@fhe-ai-context/sui-sdk';
import { getPdfExtractor } from '../packages/api/src/services/pdfExtractor';

const CHUNK_MAX_BYTES = 10 * 1024 * 1024;
const CHUNK_WINDOW_CHARS = 1500;

interface UploadRow {
  id: string;
  agent_id: string;
  walrus_blob_id: string;
  summary: string | null;
  brain_id: number;
}

function parseMime(summary: string | null): string {
  // summary format: "name · mime · sizeKB" (built in v3-marketplace.ts /upload)
  const m = (summary ?? '').split(' · ');
  return (m[1] ?? '').trim();
}

async function chunkOne(row: UploadRow, dryRun: boolean): Promise<{ written: number; reason: string }> {
  const mime = parseMime(row.summary);
  const isText = mime.startsWith('text/') || mime === 'application/json' || mime === 'application/x-yaml' || mime === 'application/yaml';
  const isPdf = mime === 'application/pdf';
  if (!isText && !isPdf) return { written: 0, reason: `unsupported-mime:${mime || 'unknown'}` };
  if (row.walrus_blob_id.startsWith('local:')) return { written: 0, reason: 'synthetic-blob-id' };

  let extracted = '';
  if (isPdf) {
    const r = await getPdfExtractor().extract(row.walrus_blob_id);
    if (r.status !== 'ok') return { written: 0, reason: `pdf-${r.status}` };
    extracted = r.text;
  } else {
    const bytes = await createWalrusStore().fetch(row.walrus_blob_id);
    if (bytes.byteLength > CHUNK_MAX_BYTES) return { written: 0, reason: 'too-large' };
    extracted = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }

  const trimmed = extracted.trim();
  if (trimmed.length < 20) return { written: 0, reason: 'no-text' };

  if (dryRun) return { written: Math.ceil(trimmed.length / CHUNK_WINDOW_CHARS), reason: 'dry-run' };

  const idxRow = await pool.query<{ max: number | string }>(
    `SELECT COALESCE(MAX(chunk_index), -1) AS max FROM knowledge_chunks WHERE brain_id = $1`,
    [row.brain_id],
  );
  let nextIdx = Number(idxRow.rows[0]?.max ?? -1) + 1;
  let written = 0;
  for (let i = 0; i < trimmed.length; i += CHUNK_WINDOW_CHARS) {
    const piece = trimmed.slice(i, i + CHUNK_WINDOW_CHARS);
    await pool.query(
      `INSERT INTO knowledge_chunks (brain_id, chunk_index, content) VALUES ($1, $2, $3)`,
      [row.brain_id, nextIdx++, piece],
    );
    written++;
  }
  await pool.query(
    `UPDATE agent_training_events SET chunks_indexed_at = now() WHERE id = $1`,
    [row.id],
  );
  return { written, reason: 'ok' };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has('--dry-run');
  const limitArg = process.argv.find((a, i) => process.argv[i - 1] === '--limit');
  const limit = limitArg ? Number(limitArg) : 100;

  const r = await pool.query<UploadRow>(
    `SELECT e.id, e.agent_id, e.walrus_blob_id, e.summary, a.brain_id
       FROM agent_training_events e
       JOIN agents a ON a.id = e.agent_id
      WHERE e.event_type = 'upload'
        AND e.chunks_indexed_at IS NULL
        AND e.walrus_blob_id IS NOT NULL
        AND e.walrus_blob_id NOT LIKE 'local:%'
      ORDER BY e.created_at ASC
      LIMIT $1`,
    [limit],
  );

  console.log(`backfill: ${r.rowCount} candidate upload row(s); dry-run=${dryRun}`);
  let totalWritten = 0;
  for (const row of r.rows) {
    try {
      const out = await chunkOne(row, dryRun);
      totalWritten += out.written;
      console.log(`  · row=${row.id} brain=${row.brain_id} blob=${row.walrus_blob_id.slice(0, 16)}… → ${out.reason} (${out.written} chunks)`);
    } catch (e) {
      console.error(`  ✗ row=${row.id} brain=${row.brain_id} → ${(e as Error).message}`);
    }
  }
  console.log(`done. total chunks ${dryRun ? 'would-write' : 'written'}: ${totalWritten}`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
