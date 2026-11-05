CREATE TABLE "payroll_deductions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"income_transaction_id" uuid NOT NULL,
	"loan_transaction_id" uuid NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"gross_income_brl" numeric(12, 2) NOT NULL,
	"income_before" jsonb NOT NULL,
	"loan_before" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reversed_at" timestamp with time zone,
	"reversal_reason" text,
	CONSTRAINT "payroll_amount_positive" CHECK ("payroll_deductions"."amount" > 0 AND "payroll_deductions"."gross_income_brl" > 0 AND "payroll_deductions"."amount" <= "payroll_deductions"."gross_income_brl"),
	CONSTRAINT "payroll_distinct_occurrences" CHECK ("payroll_deductions"."income_transaction_id" <> "payroll_deductions"."loan_transaction_id")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "cash_anchor_basis" varchar(20) DEFAULT 'recorded' NOT NULL;--> statement-breakpoint
ALTER TABLE "income_source_configs" ADD COLUMN "auto_credit_by_date" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "loan_configs" ADD COLUMN "payment_method" varchar(20);--> statement-breakpoint
ALTER TABLE "loan_configs" ADD COLUMN "income_source_account_id" uuid;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "cash_amount" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "settlement_source" varchar(20) DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "settlement_date" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payroll_deductions" ADD CONSTRAINT "payroll_deductions_user_id_user_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_deductions" ADD CONSTRAINT "payroll_deductions_income_transaction_id_transactions_id_fk" FOREIGN KEY ("income_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_deductions" ADD CONSTRAINT "payroll_deductions_loan_transaction_id_transactions_id_fk" FOREIGN KEY ("loan_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_active_loan_unique" ON "payroll_deductions" USING btree ("loan_transaction_id") WHERE reversed_at IS NULL;--> statement-breakpoint
CREATE INDEX "payroll_user_income_idx" ON "payroll_deductions" USING btree ("user_id","income_transaction_id");--> statement-breakpoint
CREATE INDEX "payroll_user_created_idx" ON "payroll_deductions" USING btree ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "loan_configs" ADD CONSTRAINT "loan_configs_income_source_account_id_accounts_id_fk" FOREIGN KEY ("income_source_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "loan_income_source_idx" ON "loan_configs" USING btree ("income_source_account_id");--> statement-breakpoint
CREATE INDEX "tx_user_settlement_idx" ON "transactions" USING btree ("user_id","settlement_date");--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_cash_anchor_basis" CHECK ("accounts"."cash_anchor_basis" IN ('recorded','effective'));--> statement-breakpoint
ALTER TABLE "loan_configs" ADD CONSTRAINT "loan_payment_method" CHECK ("loan_configs"."payment_method" IS NULL OR "loan_configs"."payment_method" IN ('bank_debit','payroll','manual'));--> statement-breakpoint
ALTER TABLE "loan_configs" ADD CONSTRAINT "loan_payroll_source" CHECK ("loan_configs"."income_source_account_id" IS NULL OR "loan_configs"."payment_method" = 'payroll');--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "tx_cash_amount_nonnegative" CHECK ("transactions"."cash_amount" IS NULL OR "transactions"."cash_amount" >= 0);--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "tx_settlement_source" CHECK ("transactions"."settlement_source" IN ('manual','bank','payroll','date_assumed','legacy'));
--> statement-breakpoint
-- S03: payroll allocations keep both transaction owners and serialize the sum.
CREATE OR REPLACE FUNCTION validate_loan_income_source()
RETURNS trigger AS $$
BEGIN
  IF NEW.income_source_account_id IS NOT NULL AND (
    NEW.payment_method IS DISTINCT FROM 'payroll' OR NOT EXISTS (
      SELECT 1 FROM accounts loan JOIN accounts income ON income.user_id = loan.user_id
      WHERE loan.id = NEW.account_id AND income.id = NEW.income_source_account_id
        AND income.type = 'revenue'
    )
  ) THEN
    RAISE EXCEPTION 'Invalid payroll income source' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_loan_income_source ON loan_configs;
CREATE TRIGGER trg_loan_income_source BEFORE INSERT OR UPDATE ON loan_configs
FOR EACH ROW EXECUTE FUNCTION validate_loan_income_source();

CREATE OR REPLACE FUNCTION validate_payroll_deduction()
RETURNS trigger AS $$
DECLARE
  income transactions%ROWTYPE;
  installment transactions%ROWTYPE;
  allocated numeric;
BEGIN
  SELECT * INTO income FROM transactions
  WHERE id = NEW.income_transaction_id AND user_id = NEW.user_id FOR UPDATE;
  IF NOT FOUND OR income.is_reversed OR income.domain_type NOT IN (
    'income_clt','income_pj','income_freelancer','income_rental','income_family_loan','income_other'
  ) OR income.domain_type IS NULL THEN
    RAISE EXCEPTION 'Invalid payroll income occurrence' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO installment FROM transactions
  WHERE id = NEW.loan_transaction_id AND user_id = NEW.user_id FOR UPDATE;
  IF NOT FOUND OR installment.is_reversed OR installment.domain_type IS DISTINCT FROM 'loan_payment'
    OR installment.currency <> 'BRL' OR installment.amount <> NEW.amount THEN
    RAISE EXCEPTION 'Invalid payroll loan occurrence' USING ERRCODE = '23514';
  END IF;
  IF NEW.reversed_at IS NULL THEN
    IF income.currency = 'BRL' AND income.amount <> NEW.gross_income_brl THEN
      RAISE EXCEPTION 'Payroll gross differs from economic income' USING ERRCODE = '23514';
    END IF;
    SELECT COALESCE(SUM(amount), 0) INTO allocated FROM payroll_deductions
    WHERE income_transaction_id = NEW.income_transaction_id AND reversed_at IS NULL AND id <> NEW.id;
    IF allocated + NEW.amount > NEW.gross_income_brl OR EXISTS (
      SELECT 1 FROM payroll_deductions WHERE income_transaction_id = NEW.income_transaction_id
      AND reversed_at IS NULL AND id <> NEW.id AND gross_income_brl <> NEW.gross_income_brl
    ) THEN
      RAISE EXCEPTION 'Payroll deductions exceed or disagree on income' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payroll_deduction ON payroll_deductions;
CREATE TRIGGER trg_payroll_deduction BEFORE INSERT OR UPDATE ON payroll_deductions
FOR EACH ROW EXECUTE FUNCTION validate_payroll_deduction();

ALTER TABLE payroll_deductions ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_deductions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payroll_user_isolation ON payroll_deductions;
CREATE POLICY payroll_user_isolation ON payroll_deductions
  USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON payroll_deductions TO app_user;
