CREATE TABLE IF NOT EXISTS brains (
  id SERIAL PRIMARY KEY,
  owner_address TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  tags TEXT[] NOT NULL DEFAULT '{}',
  ipfs_cid TEXT,
  merkle_root TEXT,
  chain TEXT NOT NULL DEFAULT 'arbitrum-sepolia',
  published BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id SERIAL PRIMARY KEY,
  brain_id INT NOT NULL REFERENCES brains(id) ON DELETE CASCADE,
  chunk_index INT NOT NULL DEFAULT 0,
  content TEXT NOT NULL,
  ipfs_cid TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id SERIAL PRIMARY KEY,
  user_address TEXT NOT NULL UNIQUE,
  tier TEXT NOT NULL,
  chain TEXT NOT NULL DEFAULT 'arbitrum-sepolia',
  tx_hash TEXT NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chat_history (
  id SERIAL PRIMARY KEY,
  user_address TEXT NOT NULL,
  brain_id INT REFERENCES brains(id) ON DELETE SET NULL,
  role TEXT NOT NULL DEFAULT 'user',
  content TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_brains_owner ON brains(owner_address);
CREATE INDEX IF NOT EXISTS idx_brains_published ON brains(published);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_address);
CREATE INDEX IF NOT EXISTS idx_chat_history_user ON chat_history(user_address, brain_id);
CREATE INDEX IF NOT EXISTS idx_chunks_brain ON knowledge_chunks(brain_id);

CREATE TABLE IF NOT EXISTS permits (
  user_address TEXT PRIMARY KEY,
  serialized_permit TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Phase 1.5: client-side encryption support. All additive, IF NOT EXISTS so
-- both fresh installs and existing databases pick these up.
ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS encrypted BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS nonce BYTEA;
ALTER TABLE brains ADD COLUMN IF NOT EXISTS key_high BYTEA;
ALTER TABLE brains ADD COLUMN IF NOT EXISTS key_low BYTEA;
