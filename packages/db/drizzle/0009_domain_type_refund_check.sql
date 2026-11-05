-- Manual migration: add 'credit_card_refund' to the domain_type CHECK constraints.
-- Applied: 2026-06-02
--
-- ROOT CAUSE: the dev/prod DBs still enforce domain_type via the legacy
-- chk_(transactions|scheduled_transactions)_domain_type CHECK constraints (the
-- varchar→enum conversion in migration 0006 was never applied here). The shared
-- DOMAIN_TYPES enum + the frontend AddRefundDialog use 'credit_card_refund', but
-- the CHECK list was never updated to include it — so creating a refund failed
-- with SQLSTATE 23514 (→ tRPC 500). This recreates both constraints with the full
-- DOMAIN_TYPES list (the only delta is 'credit_card_refund').
--
-- Pre-flight (2026-06-02): every distinct domain_type value in both tables is
-- already a member of the target list; no existing row violates the new CHECK.

DO $$
BEGIN
IF NOT EXISTS (
  SELECT 1
  FROM pg_type type
  JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
  WHERE type.typname = 'domain_type' AND namespace.nspname = 'public'
) THEN
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS chk_transactions_domain_type;
ALTER TABLE transactions ADD CONSTRAINT chk_transactions_domain_type CHECK (
  domain_type IS NULL OR (domain_type)::text = ANY (ARRAY[
    'credit_card_installment','credit_card_fixed_charge','credit_card_expense',
    'credit_card_annual_fee','credit_card_refund','bill_payment',
    'loan_payment','loan_insurance',
    'family_loan_installment','family_loan_fixed_charge','family_loan_expense','family_loan_discount',
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
    'family_loan_installment','family_loan_fixed_charge','family_loan_expense','family_loan_discount',
    'recurring_bill',
    'income_clt','income_pj','income_freelancer','income_rental','income_family_loan','income_other'
  ]::text[])
);
END IF;
END $$;
