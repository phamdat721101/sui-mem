-- 010_freemium_index.sql — fast freemium count queries
--
-- Free-preview counter lives implicitly as rows in `paid_calls` with
-- method='free' and amount_usdc=0 (allowed since 009_paid_calls_allow_zero).
--
-- Hot query (called on every buyer chat request when FEATURE_FHE_PAY=true):
--
--   SELECT COUNT(*) FROM paid_calls
--    WHERE buyer = $1 AND agent_id = $2 AND method = 'free';
--
-- This index makes the count <5ms even at 1M+ rows. Additive only;
-- rollback = DROP INDEX with zero data loss.

CREATE INDEX IF NOT EXISTS paid_calls_freemium_idx
  ON paid_calls(buyer, agent_id, method);
