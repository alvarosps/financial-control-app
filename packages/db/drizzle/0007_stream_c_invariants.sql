-- Manual migration: Stream C — Schema invariants (V2 audit medium fixes).
-- Applied: 2026-04-13
-- Covers:
--   - loan_configs.loan_type NOT NULL
--   - loan_configs.monthly_interest_rate NOT NULL
--   - credit_card_bills: CHECK ccb_paid_consistency
--
-- Pre-flight audit: packages/db/src/scripts/audit-loan-configs-nulls.ts
-- Returned 0 NULL rows on primary DB as of 2026-04-13.

-- ============================================================
-- loan_configs: tighten NULL invariants
-- ============================================================

ALTER TABLE loan_configs
  ALTER COLUMN loan_type SET NOT NULL;

ALTER TABLE loan_configs
  ALTER COLUMN monthly_interest_rate SET NOT NULL;

-- ============================================================
-- credit_card_bills: paid-state consistency
-- A bill is either:
--   (paid_at IS NULL AND paid_amount = 0) — unpaid
-- OR
--   (paid_at IS NOT NULL AND paid_amount > 0) — paid / partially paid
-- ============================================================

ALTER TABLE credit_card_bills
  ADD CONSTRAINT ccb_paid_consistency
    CHECK (
      (paid_at IS NULL AND paid_amount = 0)
      OR (paid_at IS NOT NULL AND paid_amount > 0)
    );
