-- Manual migration (psql, pattern 0009/0011/0012 -- NOT journaled).
-- Applied: 2026-07-09
--
-- Closes the transactions billing gap:
--   1. CHECK (billing_month IS NULL) = (billing_year IS NULL) -- always a pair.
--   2. CHECK billing_year IS NULL OR billing_year > 0.
--   3. tx_bill_payment_unique gets AND billing_year IS NOT NULL in the
--      predicate; a bill_payment with NULL billing values otherwise escapes
--      uniqueness because NULLs do not collide in unique indexes.
--
-- PRE-FLIGHT (run BEFORE; both must return 0 -- if not, fix data before
-- applying; see remediation queries in plan 03):
--   SELECT count(*) FROM transactions WHERE (billing_month IS NULL) <> (billing_year IS NULL);
--   SELECT count(*) FROM transactions WHERE billing_year IS NOT NULL AND billing_year <= 0;

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS chk_transactions_billing_pair;
ALTER TABLE transactions ADD CONSTRAINT chk_transactions_billing_pair
  CHECK ((billing_month IS NULL) = (billing_year IS NULL));

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS chk_transactions_billing_year_positive;
ALTER TABLE transactions ADD CONSTRAINT chk_transactions_billing_year_positive
  CHECK (billing_year IS NULL OR billing_year > 0);

DROP INDEX IF EXISTS tx_bill_payment_unique;
CREATE UNIQUE INDEX tx_bill_payment_unique
  ON transactions (destination_account_id, billing_month, billing_year)
  WHERE domain_type = 'bill_payment' AND is_reversed = false AND billing_year IS NOT NULL;
