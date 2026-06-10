-- Wipe stale tx-hash permits; add strict columns for SDK-verified permits.
TRUNCATE permits;

ALTER TABLE permits ADD COLUMN IF NOT EXISTS recipient TEXT;
ALTER TABLE permits ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE permits ADD COLUMN IF NOT EXISTS permit_kind TEXT NOT NULL DEFAULT 'sdk';

CREATE INDEX IF NOT EXISTS permits_user_expires ON permits(user_address, expires_at);
