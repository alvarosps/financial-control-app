CREATE TABLE "capture_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(80) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_received_at" timestamp with time zone,
	"rate_window_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rate_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "capture_device_values" CHECK ("capture_devices"."token_hash" ~ '^[a-f0-9]{64}$' AND length("capture_devices"."name") > 0 AND "capture_devices"."rate_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "capture_ingress_buckets" (
	"bucket" varchar(10) PRIMARY KEY NOT NULL,
	"window_at" timestamp with time zone NOT NULL,
	"attempts" integer NOT NULL,
	CONSTRAINT "capture_ingress_values" CHECK ("capture_ingress_buckets"."bucket" IN ('pair','events') AND "capture_ingress_buckets"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "capture_pairing_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" uuid,
	"name" varchar(80) NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "capture_pair_values" CHECK ("capture_pairing_codes"."code_hash" ~ '^[a-f0-9]{64}$' AND length("capture_pairing_codes"."name") > 0)
);
--> statement-breakpoint
ALTER TABLE "capture_devices" ADD CONSTRAINT "capture_devices_user_id_user_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_pairing_codes" ADD CONSTRAINT "capture_pairing_codes_user_id_user_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_pairing_codes" ADD CONSTRAINT "capture_pairing_codes_device_id_capture_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."capture_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "capture_device_token_unique" ON "capture_devices" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "capture_device_owner_idx" ON "capture_devices" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capture_pair_code_unique" ON "capture_pairing_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "capture_pair_owner_idx" ON "capture_pairing_codes" USING btree ("user_id","created_at");
ALTER TABLE capture_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE capture_devices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS capture_devices_owner ON capture_devices;
CREATE POLICY capture_devices_owner ON capture_devices
USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
ALTER TABLE capture_pairing_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE capture_pairing_codes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS capture_pairing_codes_owner ON capture_pairing_codes;
CREATE POLICY capture_pairing_codes_owner ON capture_pairing_codes
USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
ALTER TABLE capture_ingress_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE capture_ingress_buckets FORCE ROW LEVEL SECURITY;
REVOKE ALL ON capture_ingress_buckets FROM app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON capture_devices, capture_pairing_codes TO app_user;

CREATE OR REPLACE FUNCTION validate_capture_pair_owner() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.device_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.capture_devices WHERE id = NEW.device_id AND user_id = NEW.user_id
  ) THEN RAISE EXCEPTION 'Invalid capture device owner' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS capture_pair_owner ON capture_pairing_codes;
CREATE TRIGGER capture_pair_owner BEFORE INSERT OR UPDATE ON capture_pairing_codes
FOR EACH ROW EXECUTE FUNCTION validate_capture_pair_owner();

-- A high-entropy credential digest is the only lookup key before the user context exists.
CREATE OR REPLACE FUNCTION resolve_capture_credential(p_kind text, p_hash text)
RETURNS TABLE (owner_id uuid, credential_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT user_id, id FROM public.capture_pairing_codes
  WHERE p_kind = 'pair' AND code_hash = p_hash AND used_at IS NULL AND expires_at > now()
  UNION ALL
  SELECT user_id, id FROM public.capture_devices
  WHERE p_kind = 'events' AND token_hash = p_hash AND revoked_at IS NULL AND expires_at > now();
$$;
REVOKE ALL ON FUNCTION resolve_capture_credential(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_capture_credential(text, text) TO app_user;

-- Two bounded rows; failed anonymous attempts survive the later operation's rollback.
CREATE OR REPLACE FUNCTION take_capture_ingress(p_bucket text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE n integer;
BEGIN
  IF p_bucket NOT IN ('pair','events') THEN RETURN false; END IF;
  INSERT INTO public.capture_ingress_buckets (bucket, window_at, attempts)
  VALUES (p_bucket, clock_timestamp(), 1)
  ON CONFLICT (bucket) DO UPDATE SET
    attempts = CASE WHEN capture_ingress_buckets.window_at <= clock_timestamp() - interval '1 minute'
      THEN 1 ELSE LEAST(capture_ingress_buckets.attempts + 1, 1001) END,
    window_at = CASE WHEN capture_ingress_buckets.window_at <= clock_timestamp() - interval '1 minute'
      THEN clock_timestamp() ELSE capture_ingress_buckets.window_at END
  RETURNING attempts INTO n;
  RETURN n <= CASE WHEN p_bucket = 'pair' THEN 120 ELSE 1000 END;
END;
$$;
REVOKE ALL ON FUNCTION take_capture_ingress(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION take_capture_ingress(text) TO app_user;
