-- Manual migration (psql, pattern 0009/0011/0012 -- NOT journaled).
-- Applied: 2026-07-09
--
-- FK support indexes that were missing (category joins and payer-account joins
-- were doing seq scans; DELETEs in categories/accounts paid full scans for FK
-- checks). Partial where the column is mostly NULL.
-- Test DB converges via drizzle-kit push (index() in schema.ts).

CREATE INDEX IF NOT EXISTS tx_category_idx
  ON transactions (category_id) WHERE category_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tx_paid_from_idx
  ON transactions (paid_from_account_id) WHERE paid_from_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS st_category_idx
  ON scheduled_transactions (category_id);
