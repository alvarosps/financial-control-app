CREATE TABLE "bank_reconciliation_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"movement_id" uuid NOT NULL,
	"movement_version" integer NOT NULL,
	"wallet_account_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"transaction_fingerprint" varchar(64) NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "bank_reconciliation_values" CHECK ("bank_reconciliation_links"."amount" > 0 AND "bank_reconciliation_links"."movement_version" > 0 AND "bank_reconciliation_links"."transaction_fingerprint" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "external_accounts" ADD COLUMN "balance_as_of" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bank_reconciliation_links" ADD CONSTRAINT "bank_reconciliation_links_user_id_user_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliation_links" ADD CONSTRAINT "bank_reconciliation_links_movement_id_external_movements_id_fk" FOREIGN KEY ("movement_id") REFERENCES "public"."external_movements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliation_links" ADD CONSTRAINT "bank_reconciliation_links_wallet_account_id_accounts_id_fk" FOREIGN KEY ("wallet_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliation_links" ADD CONSTRAINT "bank_reconciliation_links_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bank_reconciliation_owner_idx" ON "bank_reconciliation_links" USING btree ("user_id","movement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_reconciliation_active_leg" ON "bank_reconciliation_links" USING btree ("wallet_account_id","transaction_id") WHERE "bank_reconciliation_links"."revoked_at" IS NULL;
--> statement-breakpoint

ALTER TABLE bank_reconciliation_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_reconciliation_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bank_reconciliation_owner ON bank_reconciliation_links;
CREATE POLICY bank_reconciliation_owner ON bank_reconciliation_links
USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
GRANT SELECT, INSERT ON bank_reconciliation_links TO app_user;
GRANT UPDATE (revoked_at) ON bank_reconciliation_links TO app_user;

CREATE OR REPLACE FUNCTION validate_bank_reconciliation_link() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - 'revoked_at') IS DISTINCT FROM (to_jsonb(OLD) - 'revoked_at')
      OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
      RAISE EXCEPTION 'Bank reconciliation links are immutable except revocation';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.external_movements m
    JOIN public.external_accounts e ON e.id = m.external_account_id AND e.user_id = NEW.user_id
    JOIN public.accounts a ON a.id = e.account_id AND a.user_id = NEW.user_id
    JOIN public.transactions t ON t.id = NEW.transaction_id AND t.user_id = NEW.user_id
    WHERE m.id = NEW.movement_id AND m.user_id = NEW.user_id
      AND m.version = NEW.movement_version AND m.retracted_at IS NULL
      AND e.kind = 'BANK' AND a.id = NEW.wallet_account_id AND a.type = 'checking' AND a.currency = 'BRL'
      AND (t.source_account_id = a.id OR t.destination_account_id = a.id)
      AND t.source_account_id <> t.destination_account_id
      AND t.is_paid AND NOT t.is_reversed AND t.reverses_transaction_id IS NULL
      AND t.settlement_source <> 'date_assumed'
      AND public.cash_value_brl(t.amount, t.currency, t.cash_amount) = NEW.amount
  ) THEN RAISE EXCEPTION 'Invalid owned bank reconciliation target'; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS bank_reconciliation_validate ON bank_reconciliation_links;
CREATE TRIGGER bank_reconciliation_validate BEFORE INSERT OR UPDATE ON bank_reconciliation_links
FOR EACH ROW EXECUTE FUNCTION validate_bank_reconciliation_link();
