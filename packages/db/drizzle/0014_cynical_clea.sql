CREATE TABLE "purchase_ledger_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"observation_id" uuid NOT NULL,
	"transaction_id" uuid,
	"schedule_id" uuid,
	"billing_month" integer,
	"billing_year" integer,
	"application" varchar(10) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "purchase_link_target_check" CHECK (("purchase_ledger_links"."transaction_id" IS NULL) <> ("purchase_ledger_links"."schedule_id" IS NULL)),
	CONSTRAINT "purchase_link_application_check" CHECK ("purchase_ledger_links"."application" IN ('linked','created')),
	CONSTRAINT "purchase_link_period_check" CHECK (("purchase_ledger_links"."billing_month" IS NULL AND "purchase_ledger_links"."billing_year" IS NULL) OR ("purchase_ledger_links"."schedule_id" IS NOT NULL AND "purchase_ledger_links"."billing_month" BETWEEN 1 AND 12 AND "purchase_ledger_links"."billing_year" BETWEEN 2000 AND 2200 AND "purchase_ledger_links"."billing_month" IS NOT NULL AND "purchase_ledger_links"."billing_year" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "purchase_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"card_account_id" uuid,
	"category_id" uuid,
	"description" varchar(200) NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" varchar(3) DEFAULT 'BRL' NOT NULL,
	"amount_meaning" varchar(20) DEFAULT 'unknown' NOT NULL,
	"kind" varchar(12) DEFAULT 'purchase' NOT NULL,
	"confirmation" varchar(12) DEFAULT 'observed' NOT NULL,
	"review" varchar(16) DEFAULT 'unreviewed' NOT NULL,
	"manually_corrected" boolean DEFAULT false NOT NULL,
	"unrecognized" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"purchase_date" date,
	"posted_date" date,
	"installment_number" integer,
	"total_installments" integer,
	"merged_into_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_values_check" CHECK ("purchase_observations"."amount" > 0 AND "purchase_observations"."version" > 0 AND "purchase_observations"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "purchase_states_check" CHECK ("purchase_observations"."amount_meaning" IN ('purchase_total','installment','unknown') AND "purchase_observations"."kind" IN ('purchase','refund') AND "purchase_observations"."confirmation" IN ('observed','pending','posted','retracted') AND "purchase_observations"."review" IN ('unreviewed','needs_review','accepted','ignored')),
	CONSTRAINT "purchase_installments_check" CHECK (("purchase_observations"."installment_number" IS NULL AND "purchase_observations"."total_installments" IS NULL) OR ("purchase_observations"."installment_number" IS NOT NULL AND "purchase_observations"."total_installments" IS NOT NULL AND "purchase_observations"."installment_number" BETWEEN 1 AND "purchase_observations"."total_installments" AND "purchase_observations"."total_installments" BETWEEN 1 AND 120)),
	CONSTRAINT "purchase_merge_not_self" CHECK ("purchase_observations"."merged_into_id" IS DISTINCT FROM "purchase_observations"."id")
);
--> statement-breakpoint
CREATE TABLE "financial_event_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"source_version" integer NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"parser_version" varchar(80) NOT NULL,
	"data" jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "financial_revision_values_check" CHECK ("financial_event_revisions"."source_version" > 0 AND "financial_event_revisions"."content_hash" ~ '^[a-f0-9]{64}$' AND length("financial_event_revisions"."parser_version") > 0 AND jsonb_typeof("financial_event_revisions"."data") = 'object')
);
--> statement-breakpoint
CREATE TABLE "financial_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"observation_id" uuid NOT NULL,
	"source" varchar(12) NOT NULL,
	"source_scope" varchar(128) NOT NULL,
	"external_id" varchar(200) NOT NULL,
	"current_version" integer NOT NULL,
	"current_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "financial_event_source_check" CHECK ("financial_events"."source" IN ('manual','pdf','android','pluggy') AND "financial_events"."current_version" > 0 AND length("financial_events"."source_scope") > 0 AND length("financial_events"."external_id") > 0 AND "financial_events"."current_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "purchase_ledger_links" ADD CONSTRAINT "purchase_ledger_links_user_id_user_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_ledger_links" ADD CONSTRAINT "purchase_ledger_links_observation_id_purchase_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."purchase_observations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_ledger_links" ADD CONSTRAINT "purchase_ledger_links_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_ledger_links" ADD CONSTRAINT "purchase_ledger_links_schedule_id_scheduled_transactions_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."scheduled_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_observations" ADD CONSTRAINT "purchase_observations_user_id_user_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_observations" ADD CONSTRAINT "purchase_observations_card_account_id_accounts_id_fk" FOREIGN KEY ("card_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_observations" ADD CONSTRAINT "purchase_observations_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_observations" ADD CONSTRAINT "purchase_observations_merged_into_id_purchase_observations_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."purchase_observations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_event_revisions" ADD CONSTRAINT "financial_event_revisions_user_id_user_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_event_revisions" ADD CONSTRAINT "financial_event_revisions_event_id_financial_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."financial_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_events" ADD CONSTRAINT "financial_events_user_id_user_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_events" ADD CONSTRAINT "financial_events_observation_id_purchase_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."purchase_observations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_link_active_observation" ON "purchase_ledger_links" USING btree ("observation_id") WHERE "purchase_ledger_links"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_link_active_transaction" ON "purchase_ledger_links" USING btree ("transaction_id") WHERE "purchase_ledger_links"."revoked_at" IS NULL AND "purchase_ledger_links"."transaction_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_link_active_series" ON "purchase_ledger_links" USING btree ("schedule_id") WHERE "purchase_ledger_links"."revoked_at" IS NULL AND "purchase_ledger_links"."schedule_id" IS NOT NULL AND "purchase_ledger_links"."billing_month" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_link_active_occurrence" ON "purchase_ledger_links" USING btree ("schedule_id","billing_year","billing_month") WHERE "purchase_ledger_links"."revoked_at" IS NULL AND "purchase_ledger_links"."schedule_id" IS NOT NULL AND "purchase_ledger_links"."billing_month" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "purchase_links_user_idx" ON "purchase_ledger_links" USING btree ("user_id","observation_id");--> statement-breakpoint
CREATE INDEX "purchase_inbox_cursor_idx" ON "purchase_observations" USING btree ("user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "purchase_inbox_review_idx" ON "purchase_observations" USING btree ("user_id","review","created_at");--> statement-breakpoint
CREATE INDEX "purchase_inbox_card_date_idx" ON "purchase_observations" USING btree ("user_id","card_account_id","purchase_date");--> statement-breakpoint
CREATE UNIQUE INDEX "financial_event_revision_unique" ON "financial_event_revisions" USING btree ("event_id","source_version");--> statement-breakpoint
CREATE INDEX "financial_event_revision_user_idx" ON "financial_event_revisions" USING btree ("user_id","event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "financial_event_identity" ON "financial_events" USING btree ("user_id","source","source_scope","external_id");--> statement-breakpoint
CREATE INDEX "financial_event_observation_idx" ON "financial_events" USING btree ("user_id","observation_id");
--> statement-breakpoint
-- S04: event identity, immutable revisions and owned purchase links.
CREATE OR REPLACE FUNCTION validate_purchase_observation()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'Purchase owner is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.card_account_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM accounts WHERE id = NEW.card_account_id AND user_id = NEW.user_id AND type = 'credit_card'
  ) THEN RAISE EXCEPTION 'Invalid purchase card' USING ERRCODE = '23514'; END IF;
  IF NEW.category_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM categories WHERE id = NEW.category_id AND user_id = NEW.user_id
  ) THEN RAISE EXCEPTION 'Invalid purchase category' USING ERRCODE = '23514'; END IF;
  IF NEW.merged_into_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM purchase_observations WHERE id = NEW.merged_into_id AND user_id = NEW.user_id
      AND merged_into_id IS NULL AND id <> NEW.id
  ) THEN RAISE EXCEPTION 'Invalid canonical purchase' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.card_account_id, NEW.currency, NEW.kind) IS DISTINCT FROM (OLD.card_account_id, OLD.currency, OLD.kind)
    AND EXISTS (SELECT 1 FROM purchase_ledger_links WHERE observation_id = OLD.id AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'Unlink purchase before changing its ledger identity' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_purchase_observation ON purchase_observations;
CREATE TRIGGER trg_purchase_observation BEFORE INSERT OR UPDATE ON purchase_observations
FOR EACH ROW EXECUTE FUNCTION validate_purchase_observation();

CREATE OR REPLACE FUNCTION validate_purchase_ledger_link()
RETURNS trigger AS $$
DECLARE observation purchase_observations%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.user_id, NEW.observation_id, NEW.transaction_id, NEW.schedule_id, NEW.billing_month, NEW.billing_year, NEW.application)
    IS DISTINCT FROM (OLD.user_id, OLD.observation_id, OLD.transaction_id, OLD.schedule_id, OLD.billing_month, OLD.billing_year, OLD.application) THEN
    RAISE EXCEPTION 'Revoke and recreate purchase link' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO observation FROM purchase_observations WHERE id = NEW.observation_id AND user_id = NEW.user_id;
  IF NOT FOUND OR observation.card_account_id IS NULL OR observation.merged_into_id IS NOT NULL THEN
    RAISE EXCEPTION 'Invalid purchase observation' USING ERRCODE = '23514';
  END IF;
  IF NEW.transaction_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM transactions WHERE id = NEW.transaction_id AND user_id = NEW.user_id
      AND destination_account_id = observation.card_account_id AND currency = observation.currency
      AND domain_type IN ('credit_card_expense','credit_card_installment','credit_card_fixed_charge','credit_card_refund')
      AND ((domain_type = 'credit_card_refund') = (observation.kind = 'refund'))
      AND is_reversed = false AND reverses_transaction_id IS NULL
  ) THEN RAISE EXCEPTION 'Invalid purchase transaction' USING ERRCODE = '23514'; END IF;
  IF NEW.schedule_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM scheduled_transactions WHERE id = NEW.schedule_id AND user_id = NEW.user_id
      AND destination_account_id = observation.card_account_id AND currency = observation.currency
      AND observation.kind = 'purchase' AND (
        (domain_type = 'credit_card_installment' AND NEW.billing_month IS NULL) OR
        (domain_type IN ('credit_card_fixed_charge','credit_card_expense') AND NEW.billing_month IS NOT NULL)
      )
  ) THEN RAISE EXCEPTION 'Invalid purchase schedule' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_purchase_ledger_link ON purchase_ledger_links;
CREATE TRIGGER trg_purchase_ledger_link BEFORE INSERT OR UPDATE ON purchase_ledger_links
FOR EACH ROW EXECUTE FUNCTION validate_purchase_ledger_link();

CREATE OR REPLACE FUNCTION validate_financial_event()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.user_id, NEW.source, NEW.source_scope, NEW.external_id) IS DISTINCT FROM (OLD.user_id, OLD.source, OLD.source_scope, OLD.external_id) THEN
    RAISE EXCEPTION 'Event identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM purchase_observations WHERE id = NEW.observation_id AND user_id = NEW.user_id AND merged_into_id IS NULL) THEN
    RAISE EXCEPTION 'Invalid event purchase' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_financial_event ON financial_events;
CREATE TRIGGER trg_financial_event BEFORE INSERT OR UPDATE ON financial_events
FOR EACH ROW EXECUTE FUNCTION validate_financial_event();

CREATE OR REPLACE FUNCTION validate_financial_event_revision()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM user_profiles WHERE id = OLD.user_id) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Event revisions are immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'Event revisions are immutable' USING ERRCODE = '23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM financial_events WHERE id = NEW.event_id AND user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'Invalid revision owner' USING ERRCODE = '23514';
  END IF;
  IF NOT (NEW.data ?& ARRAY['cardAccountId','description','amount','currency','amountMeaning','kind','purchaseDate','postedDate','installmentNumber','totalInstallments','confirmation']) OR EXISTS (
    SELECT 1 FROM jsonb_object_keys(NEW.data) AS k WHERE k NOT IN ('cardAccountId','description','amount','currency','amountMeaning','kind','purchaseDate','postedDate','installmentNumber','totalInstallments','confirmation')
  ) THEN RAISE EXCEPTION 'Revision must contain only normalized reconciliation fields' USING ERRCODE = '23514'; END IF;
  IF NEW.data->>'cardAccountId' IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM accounts WHERE id = (NEW.data->>'cardAccountId')::uuid AND user_id = NEW.user_id AND type = 'credit_card'
  ) THEN RAISE EXCEPTION 'Invalid revision card' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_financial_event_revision ON financial_event_revisions;
CREATE TRIGGER trg_financial_event_revision BEFORE INSERT OR UPDATE OR DELETE ON financial_event_revisions
FOR EACH ROW EXECUTE FUNCTION validate_financial_event_revision();

ALTER TABLE purchase_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_observations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS purchase_observations_user_isolation ON purchase_observations;
CREATE POLICY purchase_observations_user_isolation ON purchase_observations
USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
ALTER TABLE purchase_ledger_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_ledger_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS purchase_ledger_links_user_isolation ON purchase_ledger_links;
CREATE POLICY purchase_ledger_links_user_isolation ON purchase_ledger_links
USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
ALTER TABLE financial_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS financial_events_user_isolation ON financial_events;
CREATE POLICY financial_events_user_isolation ON financial_events
USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
ALTER TABLE financial_event_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_event_revisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS financial_event_revisions_user_isolation ON financial_event_revisions;
CREATE POLICY financial_event_revisions_user_isolation ON financial_event_revisions
USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON purchase_observations, purchase_ledger_links, financial_events, financial_event_revisions TO app_user;
