-- Manual migration: audit hardening — FK restrict, CHECK amount>0,
-- unique bill_payment partial index, firstBillingMonth/Year columns,
-- backfill for existing installment schedules.
-- Applied: 2026-04-12
-- Covers audit bugs: #1 TOCTOU payBill, #4 FK onDelete, #5 CHECK amount>0,
-- #10 unique bill_payment, plus firstBillingMonth support for #6/#7/E.

-- ============================================================
-- Bug #4: FK onDelete = RESTRICT on account-referencing FKs
-- ============================================================

ALTER TABLE transactions
  DROP CONSTRAINT IF EXISTS transactions_source_account_id_accounts_id_fk,
  DROP CONSTRAINT IF EXISTS transactions_destination_account_id_accounts_id_fk,
  DROP CONSTRAINT IF EXISTS transactions_paid_from_account_id_accounts_id_fk;

ALTER TABLE transactions
  ADD CONSTRAINT transactions_source_account_id_accounts_id_fk
    FOREIGN KEY (source_account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
  ADD CONSTRAINT transactions_destination_account_id_accounts_id_fk
    FOREIGN KEY (destination_account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
  ADD CONSTRAINT transactions_paid_from_account_id_accounts_id_fk
    FOREIGN KEY (paid_from_account_id) REFERENCES accounts(id) ON DELETE RESTRICT;

ALTER TABLE scheduled_transactions
  DROP CONSTRAINT IF EXISTS scheduled_transactions_source_account_id_accounts_id_fk,
  DROP CONSTRAINT IF EXISTS scheduled_transactions_destination_account_id_accounts_id_fk;

ALTER TABLE scheduled_transactions
  ADD CONSTRAINT scheduled_transactions_source_account_id_accounts_id_fk
    FOREIGN KEY (source_account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
  ADD CONSTRAINT scheduled_transactions_destination_account_id_accounts_id_fk
    FOREIGN KEY (destination_account_id) REFERENCES accounts(id) ON DELETE RESTRICT;

-- ============================================================
-- Bug #5: CHECK amount > 0
-- ============================================================

ALTER TABLE transactions
  ADD CONSTRAINT tx_amount_positive CHECK (amount > 0);

ALTER TABLE scheduled_transactions
  ADD CONSTRAINT sched_amount_positive CHECK (amount > 0);

-- ============================================================
-- Bug #10: UNIQUE partial index for idempotent bill_payment
-- (closes TOCTOU in bill.service.payBill at DB layer)
-- ============================================================

CREATE UNIQUE INDEX tx_bill_payment_unique
  ON transactions (destination_account_id, billing_month, billing_year)
  WHERE domain_type = 'bill_payment' AND is_reversed = false;

-- ============================================================
-- Feature support: firstBillingMonth/Year columns on scheduled_transactions
-- Populated only for credit-card installment schedules.
-- Enables materializer to assign billing periods by index rather than
-- deriving from date+closingDay (avoids closingDay edge cases).
-- ============================================================

ALTER TABLE scheduled_transactions
  ADD COLUMN first_billing_month INTEGER,
  ADD COLUMN first_billing_year INTEGER;

ALTER TABLE scheduled_transactions
  ADD CONSTRAINT sched_first_billing_both_or_none
    CHECK ((first_billing_month IS NULL) = (first_billing_year IS NULL)),
  ADD CONSTRAINT sched_first_billing_month_valid
    CHECK (first_billing_month IS NULL OR first_billing_month BETWEEN 1 AND 12);

-- ============================================================
-- Backfill firstBillingMonth/Year for existing installment schedules
-- (uses earliest billing period from already-materialized transactions)
-- ============================================================

UPDATE scheduled_transactions s
SET first_billing_month = sub.first_month,
    first_billing_year  = sub.first_year
FROM (
  SELECT t.scheduled_transaction_id AS sid,
         (array_agg(t.billing_month ORDER BY t.billing_year, t.billing_month))[1] AS first_month,
         (array_agg(t.billing_year  ORDER BY t.billing_year, t.billing_month))[1] AS first_year
  FROM transactions t
  WHERE t.scheduled_transaction_id IS NOT NULL
    AND t.billing_month IS NOT NULL
    AND t.billing_year  IS NOT NULL
  GROUP BY t.scheduled_transaction_id
) sub
WHERE s.id = sub.sid
  AND s.total_occurrences IS NOT NULL
  AND s.first_billing_month IS NULL;
