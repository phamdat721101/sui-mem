-- v2 privacy: per-brain privacy version + remove server-side key dependency
ALTER TABLE brains ADD COLUMN IF NOT EXISTS privacy_version INT DEFAULT 1;

-- Index for fast v2 brain lookup
CREATE INDEX IF NOT EXISTS idx_brains_privacy_version ON brains(privacy_version);
