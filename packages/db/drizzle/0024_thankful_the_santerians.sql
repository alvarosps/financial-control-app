CREATE TABLE "financial_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"rule" varchar(32) NOT NULL,
	"entity_key" varchar(128) NOT NULL,
	"month" integer NOT NULL,
	"year" integer NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"evidence" jsonb NOT NULL,
	"state" varchar(12) DEFAULT 'open' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"read_at" timestamp with time zone,
	"muted_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "financial_alerts_values" CHECK ("financial_alerts"."month" BETWEEN 1 AND 12 AND "financial_alerts"."year" BETWEEN 2000 AND 2200 AND "financial_alerts"."revision">0 AND "financial_alerts"."content_hash" ~ '^[a-f0-9]{64}$' AND jsonb_typeof("financial_alerts"."evidence")='object' AND "financial_alerts"."state" IN ('open','read','muted','resolved') AND "financial_alerts"."rule" IN ('stale_statement','reconciliation_difference','unrecognized_purchase','budget_near','budget_exceeded','projected_commitment','recurring_candidate','recurring_price','cash_coverage'))
);
--> statement-breakpoint
ALTER TABLE "financial_alerts" ADD CONSTRAINT "financial_alerts_user_id_user_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "financial_alerts_identity" ON "financial_alerts" USING btree ("user_id","rule","entity_key","year","month");--> statement-breakpoint
CREATE INDEX "financial_alerts_owner_state" ON "financial_alerts" USING btree ("user_id","state","year","month");
--> statement-breakpoint
ALTER TABLE financial_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_alerts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS financial_alerts_owner ON financial_alerts;
CREATE POLICY financial_alerts_owner ON financial_alerts FOR ALL USING (user_id = current_setting('app.current_user_id', true)::uuid) WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);
GRANT SELECT, INSERT ON financial_alerts TO app_user;
GRANT UPDATE (content_hash, revision, evidence, state, active, read_at, muted_at, resolved_at, updated_at) ON financial_alerts TO app_user;
CREATE OR REPLACE FUNCTION validate_financial_alert_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['content_hash','revision','evidence','state','active','read_at','muted_at','resolved_at','updated_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['content_hash','revision','evidence','state','active','read_at','muted_at','resolved_at','updated_at']) OR NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'Alert identity is immutable and revision must advance';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS financial_alerts_validate ON financial_alerts;
CREATE TRIGGER financial_alerts_validate BEFORE UPDATE ON financial_alerts FOR EACH ROW EXECUTE FUNCTION validate_financial_alert_update();
DROP TRIGGER IF EXISTS financial_alerts_updated_at ON financial_alerts;
CREATE TRIGGER financial_alerts_updated_at BEFORE UPDATE ON financial_alerts FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
