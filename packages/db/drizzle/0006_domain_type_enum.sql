-- Manual migration: convert domain_type columns from varchar(50) to pgEnum.
-- Applied: 2026-04-12
-- Covers Front H — Contracts & enums (Round 2 audit fixes).
--
-- Pre-flight check: packages/db/src/pre-migration/check-domain-types.ts
-- verifies every distinct value in transactions.domain_type and
-- scheduled_transactions.domain_type already belongs to the target enum.
--
-- Note: the partial unique index tx_bill_payment_unique is dropped BEFORE
-- the column conversion (its predicate `domain_type = 'bill_payment'` is
-- not IMMUTABLE across the varchar -> enum cast) and recreated afterward
-- so the new predicate references the enum value directly.

-- ============================================================
-- 1. Create the enum type
-- ============================================================

CREATE TYPE "public"."domain_type" AS ENUM (
  'credit_card_installment',
  'credit_card_fixed_charge',
  'credit_card_expense',
  'credit_card_annual_fee',
  'credit_card_refund',
  'bill_payment',
  'loan_payment',
  'loan_insurance',
  'family_loan_installment',
  'family_loan_fixed_charge',
  'family_loan_expense',
  'family_loan_discount',
  'recurring_bill',
  'income_clt',
  'income_pj',
  'income_freelancer',
  'income_rental',
  'income_family_loan',
  'income_other'
);--> statement-breakpoint

-- ============================================================
-- 2. Drop the partial unique index that depends on the varchar column
-- ============================================================

DROP INDEX IF EXISTS "tx_bill_payment_unique";--> statement-breakpoint

-- ============================================================
-- 3. Alter columns to use the enum. The `USING domain_type::domain_type`
--    cast is REQUIRED — Postgres does not implicitly cast varchar to
--    enum. drizzle-kit is known to omit this clause for custom-enum
--    conversions, so the SQL is hand-authored.
-- ============================================================

ALTER TABLE "transactions"
  ALTER COLUMN "domain_type" TYPE "public"."domain_type"
  USING "domain_type"::"public"."domain_type";--> statement-breakpoint

ALTER TABLE "scheduled_transactions"
  ALTER COLUMN "domain_type" TYPE "public"."domain_type"
  USING "domain_type"::"public"."domain_type";--> statement-breakpoint

-- ============================================================
-- 4. Recreate the partial unique index against the enum column.
-- ============================================================

CREATE UNIQUE INDEX "tx_bill_payment_unique"
  ON "transactions" ("destination_account_id", "billing_month", "billing_year")
  WHERE domain_type = 'bill_payment' AND is_reversed = false;
