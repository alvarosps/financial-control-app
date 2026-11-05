CREATE TABLE "classification_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"items" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_at" timestamp with time zone,
	"undo_reason" text,
	CONSTRAINT "classification_batches_values" CHECK (jsonb_typeof("classification_batches"."items") = 'array' AND jsonb_array_length("classification_batches"."items") BETWEEN 1 AND 100 AND (("classification_batches"."undone_at" IS NULL AND "classification_batches"."undo_reason" IS NULL) OR ("classification_batches"."undone_at" IS NOT NULL AND length(btrim("classification_batches"."undo_reason")) >= 3)))
);
--> statement-breakpoint
CREATE TABLE "classification_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"merchant" varchar(500) NOT NULL,
	"card_account_id" uuid,
	"category_id" uuid NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "classification_rules_values" CHECK ("classification_rules"."version" > 0 AND "classification_rules"."priority" BETWEEN 0 AND 1000 AND length(btrim("classification_rules"."merchant")) > 0)
);
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "classification_source" varchar(12) DEFAULT 'unreviewed' NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "classification_rule_id" uuid;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "classification_rule_version" integer;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "classification_confidence" varchar(12);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "classification_reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "economic_responsibility" varchar(12) DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "receivable_account_id" uuid;--> statement-breakpoint
ALTER TABLE "classification_batches" ADD CONSTRAINT "classification_batches_user_id_user_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classification_rules" ADD CONSTRAINT "classification_rules_user_id_user_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classification_rules" ADD CONSTRAINT "classification_rules_card_account_id_accounts_id_fk" FOREIGN KEY ("card_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classification_rules" ADD CONSTRAINT "classification_rules_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "classification_batches_owner_idx" ON "classification_batches" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "classification_rules_owner_idx" ON "classification_rules" USING btree ("user_id","merchant");--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_classification_rule_id_classification_rules_id_fk" FOREIGN KEY ("classification_rule_id") REFERENCES "public"."classification_rules"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_receivable_account_id_accounts_id_fk" FOREIGN KEY ("receivable_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "tx_classification_values" CHECK ("transactions"."classification_source" IN ('unreviewed','manual','rule') AND "transactions"."economic_responsibility" IN ('unknown','own','family','work','property') AND ("transactions"."classification_confidence" IS NULL OR "transactions"."classification_confidence" IN ('exact','ambiguous')) AND (("transactions"."classification_source" = 'unreviewed' AND "transactions"."classification_reviewed_at" IS NULL) OR ("transactions"."classification_source" <> 'unreviewed' AND "transactions"."classification_reviewed_at" IS NOT NULL)) AND (("transactions"."classification_rule_id" IS NULL AND "transactions"."classification_rule_version" IS NULL AND "transactions"."classification_source" <> 'rule') OR ("transactions"."classification_rule_id" IS NOT NULL AND "transactions"."classification_rule_version" > 0 AND "transactions"."classification_source" = 'rule')));
--> statement-breakpoint
ALTER TABLE classification_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE classification_rules FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS classification_rules_owner ON classification_rules;
CREATE POLICY classification_rules_owner ON classification_rules USING (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid) WITH CHECK (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);
ALTER TABLE classification_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE classification_batches FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS classification_batches_owner ON classification_batches;
CREATE POLICY classification_batches_owner ON classification_batches USING (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid) WITH CHECK (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);
REVOKE ALL ON classification_rules, classification_batches FROM app_user;
GRANT SELECT, INSERT ON classification_rules, classification_batches TO app_user;
GRANT UPDATE (enabled, version) ON classification_rules TO app_user;
GRANT UPDATE (undone_at, undo_reason) ON classification_batches TO app_user;

CREATE OR REPLACE FUNCTION validate_classification_owner() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE item jsonb;
BEGIN
  IF TG_TABLE_NAME = 'classification_rules' THEN
    IF NOT EXISTS (SELECT 1 FROM public.categories WHERE id = NEW.category_id AND user_id = NEW.user_id AND type = 'expense')
      OR (NEW.card_account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.accounts WHERE id = NEW.card_account_id AND user_id = NEW.user_id AND type = 'credit_card')) THEN RAISE EXCEPTION 'CLASSIFICATION_OWNER_MISMATCH'; END IF;
    IF TG_OP = 'UPDATE' AND ((to_jsonb(NEW) - ARRAY['enabled','version']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['enabled','version']) OR NEW.version <> OLD.version + 1) THEN RAISE EXCEPTION 'CLASSIFICATION_RULE_IMMUTABLE'; END IF;
  ELSIF TG_TABLE_NAME = 'classification_batches' THEN
    IF TG_OP = 'UPDATE' THEN
      IF (to_jsonb(NEW) - ARRAY['undone_at','undo_reason']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['undone_at','undo_reason']) OR OLD.undone_at IS NOT NULL OR NEW.undone_at IS NULL THEN RAISE EXCEPTION 'CLASSIFICATION_BATCH_IMMUTABLE'; END IF;
    ELSE
      FOR item IN SELECT * FROM jsonb_array_elements(NEW.items) LOOP
        IF NOT EXISTS (SELECT 1 FROM public.transactions WHERE id = (item->>'transactionId')::uuid AND user_id = NEW.user_id) THEN RAISE EXCEPTION 'CLASSIFICATION_OWNER_MISMATCH'; END IF;
      END LOOP;
    END IF;
  ELSE
    IF (NEW.category_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.categories WHERE id = NEW.category_id AND user_id = NEW.user_id))
      OR (NEW.classification_rule_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.classification_rules WHERE id = NEW.classification_rule_id AND user_id = NEW.user_id AND category_id = NEW.category_id AND version >= NEW.classification_rule_version))
      OR (NEW.receivable_account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.accounts WHERE id = NEW.receivable_account_id AND user_id = NEW.user_id AND type = 'family_loan')) THEN RAISE EXCEPTION 'CLASSIFICATION_OWNER_MISMATCH'; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS classification_rules_owner_check ON classification_rules;
CREATE TRIGGER classification_rules_owner_check BEFORE INSERT OR UPDATE ON classification_rules FOR EACH ROW EXECUTE FUNCTION validate_classification_owner();
DROP TRIGGER IF EXISTS classification_batches_owner_check ON classification_batches;
CREATE TRIGGER classification_batches_owner_check BEFORE INSERT OR UPDATE ON classification_batches FOR EACH ROW EXECUTE FUNCTION validate_classification_owner();
DROP TRIGGER IF EXISTS transactions_classification_owner_check ON transactions;
CREATE TRIGGER transactions_classification_owner_check BEFORE INSERT OR UPDATE ON transactions FOR EACH ROW EXECUTE FUNCTION validate_classification_owner();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_payroll_transaction()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM payroll_deductions p WHERE p.reversed_at IS NULL
      AND (p.income_transaction_id = OLD.id OR p.loan_transaction_id = OLD.id)
  ) AND (to_jsonb(NEW) - ARRAY['description','category_id','notes','updated_at','classification_source','classification_rule_id','classification_rule_version','classification_confidence','classification_reviewed_at','economic_responsibility','receivable_account_id'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['description','category_id','notes','updated_at','classification_source','classification_rule_id','classification_rule_version','classification_confidence','classification_reviewed_at','economic_responsibility','receivable_account_id']) THEN
    RAISE EXCEPTION 'Undo payroll before changing an allocated occurrence' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
