-- Manual migration (applied by hand via psql, like 0009/0011 — NOT journaled).
-- Applied: 2026-06-07
--
-- Defense-in-depth: bound transactions.billing_month to 1..12 (or NULL). Mirrors
-- the existing guard on scheduled_transactions.first_billing_month. Without this,
-- a malformed billing_month (0/>12) would reach make_date(...) in the family-loan
-- ledger's grouped SQL and 500 the request (the code now also falls back to date,
-- but the DB constraint makes the bad state unrepresentable). Pre-flight: zero
-- existing rows violate the bound.
--
-- db:safe-migrate will NOT apply this (not journaled). Apply by hand after pg_dump:
--   psql ... -f drizzle/0012_transactions_billing_month_check.sql
-- The test DB grows it via drizzle-kit push (schema check()) on test:db:reset.

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS chk_transactions_billing_month;
ALTER TABLE transactions ADD CONSTRAINT chk_transactions_billing_month
  CHECK (billing_month IS NULL OR (billing_month BETWEEN 1 AND 12));
