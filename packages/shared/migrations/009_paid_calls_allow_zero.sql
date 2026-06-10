-- 009_paid_calls_allow_zero.sql — PRD-2 lands free, rate-limited demo calls
-- through the same `paid_calls` ledger as paid x402/fherc20 traffic, so
-- seller earnings dashboards can filter on method ('demo' vs 'exact'/'fherc20')
-- in one query. Demo rows record amount_usdc=0; the original CHECK
-- (amount_usdc > 0) made that invalid. Widening to >= 0 keeps the safety
-- (no negative amounts) while permitting legitimate zero rows.

ALTER TABLE paid_calls DROP CONSTRAINT IF EXISTS paid_calls_amount_usdc_check;
ALTER TABLE paid_calls
  ADD CONSTRAINT paid_calls_amount_usdc_check
  CHECK (amount_usdc >= 0);
