-- Manual migration: statement-import audit and idempotency drafts.
-- Additive only. Apply after a successful backup.

CREATE TABLE IF NOT EXISTS "fatura_imports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "card_account_id" uuid NOT NULL,
  "billing_month" integer NOT NULL,
  "billing_year" integer NOT NULL,
  "due_date" date NOT NULL,
  "status" varchar(20) NOT NULL DEFAULT 'draft',
  "file_name" varchar(255),
  "profile_id" varchar(50) NOT NULL,
  "model_used" varchar(100) NOT NULL,
  "parsed_total" numeric(14, 2) NOT NULL,
  "stated_total" numeric(14, 2),
  "items_json" jsonb NOT NULL,
  "applied_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "fatura_imports_status_check"
    CHECK ("status" IN ('draft', 'applied', 'discarded')),
  CONSTRAINT "fatura_imports_billing_month_check"
    CHECK ("billing_month" BETWEEN 1 AND 12),
  CONSTRAINT "fatura_imports_user_id_user_profiles_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "user_profiles"("id") ON DELETE CASCADE,
  CONSTRAINT "fatura_imports_card_account_id_accounts_id_fk"
    FOREIGN KEY ("card_account_id") REFERENCES "accounts"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "fatura_imports_user_card_idx"
  ON "fatura_imports" ("user_id", "card_account_id", "billing_year", "billing_month");

ALTER TABLE fatura_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE fatura_imports FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fatura_imports_user_isolation ON fatura_imports;
CREATE POLICY fatura_imports_user_isolation ON fatura_imports
  USING (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

DROP TRIGGER IF EXISTS trg_updated_at_fatura_imports ON fatura_imports;
CREATE TRIGGER trg_updated_at_fatura_imports
  BEFORE UPDATE ON fatura_imports
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON fatura_imports TO app_user;
