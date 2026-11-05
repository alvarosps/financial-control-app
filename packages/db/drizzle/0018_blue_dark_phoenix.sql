CREATE TABLE "external_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"external_id" uuid NOT NULL,
	"account_id" uuid,
	"kind" varchar(8) NOT NULL,
	"name" varchar(200) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"balance" numeric(14, 2),
	"balance_type" varchar(16) DEFAULT 'unknown' NOT NULL,
	"fetched_at" timestamp with time zone,
	"source_updated_at" timestamp with time zone,
	CONSTRAINT "external_account_values" CHECK ("external_accounts"."kind" IN ('BANK','CREDIT') AND "external_accounts"."currency" ~ '^[A-Z]{3}$' AND "external_accounts"."balance_type" IN ('unknown','book','available','limit'))
);
--> statement-breakpoint
CREATE TABLE "external_bills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"external_account_id" uuid NOT NULL,
	"external_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"last_fetched_at" timestamp with time zone,
	"source_updated_at" timestamp with time zone,
	"error_code" varchar(80),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_connection_status" CHECK ("external_connections"."status" IN ('active','paused','auth_required','error'))
);
--> statement-breakpoint
CREATE TABLE "external_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"external_account_id" uuid NOT NULL,
	"external_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"source_updated_at" timestamp with time zone NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retracted_at" timestamp with time zone,
	"reviewed_version" integer,
	CONSTRAINT "external_movement_values" CHECK ("external_movements"."version" > 0 AND "external_movements"."content_hash" ~ '^[a-f0-9]{64}$' AND ("external_movements"."reviewed_version" IS NULL OR "external_movements"."reviewed_version" BETWEEN 1 AND "external_movements"."version"))
);
--> statement-breakpoint
CREATE TABLE "integration_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"idempotency_key" varchar(200) NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"checkpoint" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" varchar(12) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease" uuid,
	"lease_expires_at" timestamp with time zone,
	"error_code" varchar(80),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_job_values" CHECK ("integration_jobs"."status" IN ('pending','running','completed','failed') AND "integration_jobs"."attempts" >= 0 AND (("integration_jobs"."lease" IS NULL AND "integration_jobs"."lease_expires_at" IS NULL) OR ("integration_jobs"."lease" IS NOT NULL AND "integration_jobs"."lease_expires_at" IS NOT NULL)))
);
--> statement-breakpoint
ALTER TABLE "external_accounts" ADD CONSTRAINT "external_accounts_user_id_user_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_accounts" ADD CONSTRAINT "external_accounts_connection_id_external_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."external_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_accounts" ADD CONSTRAINT "external_accounts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_bills" ADD CONSTRAINT "external_bills_user_id_user_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_bills" ADD CONSTRAINT "external_bills_external_account_id_external_accounts_id_fk" FOREIGN KEY ("external_account_id") REFERENCES "public"."external_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_connections" ADD CONSTRAINT "external_connections_user_id_user_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_movements" ADD CONSTRAINT "external_movements_user_id_user_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_movements" ADD CONSTRAINT "external_movements_external_account_id_external_accounts_id_fk" FOREIGN KEY ("external_account_id") REFERENCES "public"."external_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_jobs" ADD CONSTRAINT "integration_jobs_user_id_user_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_jobs" ADD CONSTRAINT "integration_jobs_connection_id_external_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."external_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "external_account_provider_unique" ON "external_accounts" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX "external_account_owner_idx" ON "external_accounts" USING btree ("user_id","connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "external_account_mapping_unique" ON "external_accounts" USING btree ("account_id") WHERE "external_accounts"."account_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "external_bill_identity" ON "external_bills" USING btree ("external_account_id","external_id");--> statement-breakpoint
CREATE INDEX "external_bill_owner_idx" ON "external_bills" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "external_connection_item_unique" ON "external_connections" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "external_connection_owner_idx" ON "external_connections" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "external_movement_identity" ON "external_movements" USING btree ("external_account_id","external_id");--> statement-breakpoint
CREATE INDEX "external_movement_owner_idx" ON "external_movements" USING btree ("user_id","external_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_job_idempotency" ON "integration_jobs" USING btree ("connection_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "integration_job_ready_idx" ON "integration_jobs" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "integration_job_owner_idx" ON "integration_jobs" USING btree ("user_id");
--> statement-breakpoint

-- S06: provider staging is owned; the global scheduler has no financial table access.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'integration_scheduler') THEN
    CREATE ROLE integration_scheduler NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO integration_scheduler;

ALTER TABLE external_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_connections FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS external_connections_owner ON external_connections;
CREATE POLICY external_connections_owner ON external_connections USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
ALTER TABLE external_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_accounts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS external_accounts_owner ON external_accounts;
CREATE POLICY external_accounts_owner ON external_accounts USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
ALTER TABLE external_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_movements FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS external_movements_owner ON external_movements;
CREATE POLICY external_movements_owner ON external_movements USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
ALTER TABLE external_bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_bills FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS external_bills_owner ON external_bills;
CREATE POLICY external_bills_owner ON external_bills USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
ALTER TABLE integration_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS integration_jobs_owner ON integration_jobs;
CREATE POLICY integration_jobs_owner ON integration_jobs USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON external_connections, external_accounts, external_movements, external_bills TO app_user;
REVOKE ALL ON integration_jobs FROM app_user;
GRANT SELECT ON integration_jobs TO app_user;
GRANT INSERT (user_id, connection_id, idempotency_key, payload) ON integration_jobs TO app_user;
-- Row locking needs a column UPDATE privilege; this is not a lease or ownership field.
GRANT UPDATE (updated_at) ON integration_jobs TO app_user;

CREATE OR REPLACE FUNCTION validate_external_owner() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_TABLE_NAME IN ('external_accounts','integration_jobs') THEN
    IF NOT EXISTS (SELECT 1 FROM public.external_connections WHERE id = NEW.connection_id AND user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'INTEGRATION_OWNER_MISMATCH';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.external_accounts WHERE id = NEW.external_account_id AND user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'INTEGRATION_OWNER_MISMATCH';
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'external_accounts' THEN
    IF NEW.account_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.accounts WHERE id = NEW.account_id AND user_id = NEW.user_id AND currency = NEW.currency
        AND ((NEW.kind = 'CREDIT' AND type = 'credit_card') OR (NEW.kind = 'BANK' AND type IN ('checking','savings')))
    ) THEN RAISE EXCEPTION 'INTEGRATION_ACCOUNT_MISMATCH'; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS external_accounts_owner_check ON external_accounts;
CREATE TRIGGER external_accounts_owner_check BEFORE INSERT OR UPDATE ON external_accounts FOR EACH ROW EXECUTE FUNCTION validate_external_owner();
DROP TRIGGER IF EXISTS external_movements_owner_check ON external_movements;
CREATE TRIGGER external_movements_owner_check BEFORE INSERT OR UPDATE ON external_movements FOR EACH ROW EXECUTE FUNCTION validate_external_owner();
DROP TRIGGER IF EXISTS external_bills_owner_check ON external_bills;
CREATE TRIGGER external_bills_owner_check BEFORE INSERT OR UPDATE ON external_bills FOR EACH ROW EXECUTE FUNCTION validate_external_owner();
DROP TRIGGER IF EXISTS integration_jobs_owner_check ON integration_jobs;
CREATE TRIGGER integration_jobs_owner_check BEFORE INSERT OR UPDATE ON integration_jobs FOR EACH ROW EXECUTE FUNCTION validate_external_owner();

CREATE OR REPLACE FUNCTION claim_integration_job()
RETURNS TABLE(job_id uuid, lease_token uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.integration_jobs SET status = 'failed', lease = NULL, lease_expires_at = NULL, error_code = 'ATTEMPTS_EXHAUSTED'
    WHERE attempts >= 8 AND status = 'running' AND lease_expires_at <= clock_timestamp();
  RETURN QUERY
  WITH candidate AS (
    SELECT j.id FROM public.integration_jobs j JOIN public.external_connections c ON c.id = j.connection_id AND c.user_id = j.user_id
    WHERE c.status = 'active' AND j.attempts < 8 AND j.next_attempt_at <= clock_timestamp()
      AND (j.status = 'pending' OR (j.status = 'running' AND j.lease_expires_at <= clock_timestamp()))
    ORDER BY j.next_attempt_at, j.created_at, j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1
  ) UPDATE public.integration_jobs j
    SET status = 'running', lease = gen_random_uuid(), lease_expires_at = clock_timestamp() + interval '120 seconds', attempts = j.attempts + 1, updated_at = clock_timestamp()
    FROM candidate WHERE j.id = candidate.id RETURNING j.id, j.lease;
END $$;
REVOKE ALL ON FUNCTION claim_integration_job() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_integration_job() TO integration_scheduler;

CREATE OR REPLACE FUNCTION resolve_integration_job(p_job uuid, p_lease uuid)
RETURNS TABLE(owner_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT j.user_id FROM public.integration_jobs j JOIN public.external_connections c ON c.id = j.connection_id AND c.user_id = j.user_id
  WHERE j.id = p_job AND j.lease = p_lease AND j.lease_expires_at > clock_timestamp() AND j.status = 'running' AND c.status = 'active'
$$;
REVOKE ALL ON FUNCTION resolve_integration_job(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_integration_job(uuid, uuid) TO integration_scheduler;

CREATE OR REPLACE FUNCTION checkpoint_integration_job(p_job uuid, p_lease uuid, p_checkpoint jsonb, p_done boolean, p_error text, p_delay integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE changed integer;
BEGIN
  IF p_delay < 0 OR p_delay > 86400 OR octet_length(p_checkpoint::text) > 100000 OR length(p_error) > 80 THEN
    RAISE EXCEPTION 'INTEGRATION_CHECKPOINT_INVALID';
  END IF;
  UPDATE public.integration_jobs j SET checkpoint = p_checkpoint,
    status = CASE WHEN p_done THEN 'completed' WHEN p_error IS NOT NULL AND attempts >= 8 THEN 'failed' ELSE 'pending' END,
    attempts = CASE WHEN p_error IS NULL THEN 0 ELSE attempts END,
    next_attempt_at = clock_timestamp() + p_delay * interval '1 second', error_code = p_error,
    lease = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
  WHERE j.id = p_job AND j.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    AND j.lease = p_lease AND j.status = 'running' AND j.lease_expires_at > clock_timestamp()
    AND EXISTS (SELECT 1 FROM public.external_connections c WHERE c.id = j.connection_id AND c.user_id = j.user_id AND c.status = 'active');
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END $$;
REVOKE ALL ON FUNCTION checkpoint_integration_job(uuid, uuid, jsonb, boolean, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION checkpoint_integration_job(uuid, uuid, jsonb, boolean, text, integer) TO app_user;
