-- Manual migration (applied by hand via psql, like 0009/0010 — NOT journaled).
-- Applied: 2026-06-07
--
-- Two changes for the family-loan payments/arrears feature:
--   1. family_loan_configs.receipt_day — the expected day-of-month money comes in
--      (used by the daily-control collapsed receipt + the dashboard planner).
--   2. Add 'family_loan_payment' to the enum or legacy CHECK constraints.
--
-- Rationale for hand-application (see also 0009 header): dev/prod enforce
-- domain_type via chk_(transactions|scheduled_transactions)_domain_type
-- (varchar + CHECK; the 0006 enum conversion was never applied here). The Drizzle
-- snapshot still models domain_type as a pgEnum, so `db:generate` emits a harmful
-- `ALTER TYPE ... ADD VALUE` that errors (42704) against the varchar column — that
-- generated migration is intentionally NOT used. The test DB grows the value via
-- `drizzle-kit push` (pgEnum) from @fc/shared. This file is the dev/prod path.

-- 1. receipt_day column (idempotent)
ALTER TABLE family_loan_configs ADD COLUMN IF NOT EXISTS receipt_day integer NOT NULL DEFAULT 10;

-- 2. domain_type CHECK constraints — recreate with the full list + family_loan_payment.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_type type
    JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
    WHERE type.typname = 'domain_type' AND namespace.nspname = 'public'
  ) THEN
    ALTER TYPE public.domain_type ADD VALUE IF NOT EXISTS 'family_loan_payment' BEFORE 'recurring_bill';
  ELSE
    ALTER TABLE transactions DROP CONSTRAINT IF EXISTS chk_transactions_domain_type;
    ALTER TABLE transactions ADD CONSTRAINT chk_transactions_domain_type CHECK (
      domain_type IS NULL OR (domain_type)::text = ANY (ARRAY[
        'credit_card_installment','credit_card_fixed_charge','credit_card_expense',
        'credit_card_annual_fee','credit_card_refund','bill_payment',
        'loan_payment','loan_insurance',
        'family_loan_installment','family_loan_fixed_charge','family_loan_expense','family_loan_discount','family_loan_payment',
        'recurring_bill',
        'income_clt','income_pj','income_freelancer','income_rental','income_family_loan','income_other'
      ]::text[])
    );

    ALTER TABLE scheduled_transactions DROP CONSTRAINT IF EXISTS chk_scheduled_transactions_domain_type;
    ALTER TABLE scheduled_transactions ADD CONSTRAINT chk_scheduled_transactions_domain_type CHECK (
      domain_type IS NULL OR (domain_type)::text = ANY (ARRAY[
        'credit_card_installment','credit_card_fixed_charge','credit_card_expense',
        'credit_card_annual_fee','credit_card_refund','bill_payment',
        'loan_payment','loan_insurance',
        'family_loan_installment','family_loan_fixed_charge','family_loan_expense','family_loan_discount','family_loan_payment',
        'recurring_bill',
        'income_clt','income_pj','income_freelancer','income_rental','income_family_loan','income_other'
      ]::text[])
    );
  END IF;
END $$;
