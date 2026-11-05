CREATE OR REPLACE FUNCTION protect_payroll_transaction()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM payroll_deductions p WHERE p.reversed_at IS NULL
      AND (p.income_transaction_id = OLD.id OR p.loan_transaction_id = OLD.id)
  ) AND (to_jsonb(NEW) - ARRAY['description','category_id','notes','updated_at'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['description','category_id','notes','updated_at']) THEN
    RAISE EXCEPTION 'Undo payroll before changing an allocated occurrence' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_protect_payroll_transaction ON transactions;
CREATE TRIGGER trg_protect_payroll_transaction BEFORE UPDATE ON transactions
FOR EACH ROW EXECUTE FUNCTION protect_payroll_transaction();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_payroll_loan_binding()
RETURNS trigger AS $$
BEGIN
  IF (NEW.payment_method, NEW.income_source_account_id, NEW.account_id)
    IS DISTINCT FROM (OLD.payment_method, OLD.income_source_account_id, OLD.account_id)
    AND EXISTS (
      SELECT 1 FROM payroll_deductions p JOIN transactions t ON t.id = p.loan_transaction_id
      WHERE t.destination_account_id = OLD.account_id AND p.reversed_at IS NULL
    ) THEN
    RAISE EXCEPTION 'Undo payroll before changing its loan binding' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_protect_payroll_loan_binding ON loan_configs;
CREATE TRIGGER trg_protect_payroll_loan_binding BEFORE UPDATE ON loan_configs
FOR EACH ROW EXECUTE FUNCTION protect_payroll_loan_binding();
