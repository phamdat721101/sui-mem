-- 030_task_uploads.sql — agent workspace ephemeral uploads (PRD-E port).
--
-- Files attached to a paid /try call live here. Walrus is the bytes;
-- this row is the metadata + (for PDFs) the cached extracted text so
-- the inference path is read-only in the hot path.
--
-- Caps enforced at column level so no API code path can bypass them:
--   - 50 MB hard ceiling on the bytes (column CHECK)
--   - 24h TTL via expires_at (cleanup is an out-of-band cron, not in scope)
--   - extraction_status closed enum
--
-- Idempotent across two starting points:
--   (a) fresh DB — CREATE TABLE … IF NOT EXISTS lands the canonical shape.
--   (b) DB that already has an older `task_uploads` (uploader_addr +
--       storage_path columns) — the IF EXISTS RENAME columns brings it to
--       the canonical shape; the ADD COLUMN IF NOT EXISTS lands the PDF
--       extraction columns.
-- Re-running this migration is always a no-op on a converged schema.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS task_uploads (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id           UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  payer_address      TEXT,
  walrus_blob_id     TEXT NOT NULL,
  original_name      TEXT NOT NULL,
  mime_type          TEXT NOT NULL,
  size_bytes         BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 52428800),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours'),
  consumed_at        TIMESTAMPTZ
);

-- Bring older schema to canonical shape. Each rename is guarded so re-runs
-- are no-ops once columns are renamed.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'task_uploads' AND column_name = 'uploader_addr') THEN
    ALTER TABLE task_uploads RENAME COLUMN uploader_addr TO payer_address;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'task_uploads' AND column_name = 'storage_path') THEN
    ALTER TABLE task_uploads RENAME COLUMN storage_path TO walrus_blob_id;
  END IF;
END$$;

-- PDF extraction columns. Sync-extract at /uploads confirm time caches the
-- result here so the inference hot path is read-only.
ALTER TABLE task_uploads ADD COLUMN IF NOT EXISTS extracted_text TEXT;
ALTER TABLE task_uploads ADD COLUMN IF NOT EXISTS extraction_status TEXT;
ALTER TABLE task_uploads ADD COLUMN IF NOT EXISTS extracted_at TIMESTAMPTZ;

-- Backfill default + closed enum CHECK on extraction_status (idempotent).
UPDATE task_uploads SET extraction_status = 'not_applicable'
  WHERE extraction_status IS NULL;

ALTER TABLE task_uploads
  ALTER COLUMN extraction_status SET DEFAULT 'not_applicable',
  ALTER COLUMN extraction_status SET NOT NULL;

ALTER TABLE task_uploads DROP CONSTRAINT IF EXISTS task_uploads_extraction_status_check;
ALTER TABLE task_uploads
  ADD CONSTRAINT task_uploads_extraction_status_check
  CHECK (extraction_status IN (
    'ok','password_protected','no_text',
    'extraction_failed','timeout','too_large','not_applicable'
  ));

CREATE INDEX IF NOT EXISTS task_uploads_agent_idx ON task_uploads(agent_id);
CREATE INDEX IF NOT EXISTS task_uploads_expires_idx
  ON task_uploads(expires_at) WHERE consumed_at IS NULL;

-- Free full-text search over PDF-extracted bodies. Only indexes 'ok' rows
-- so the index stays small even with many non-PDF or failed rows.
CREATE INDEX IF NOT EXISTS task_uploads_pdf_search_idx
  ON task_uploads USING GIN (to_tsvector('english', coalesce(extracted_text, '')))
  WHERE extraction_status = 'ok';
