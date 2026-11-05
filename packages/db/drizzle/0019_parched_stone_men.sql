CREATE TABLE "integration_ingress_buckets" (
	"bucket" varchar(12) PRIMARY KEY NOT NULL,
	"window_at" timestamp with time zone NOT NULL,
	"attempts" integer NOT NULL,
	CONSTRAINT "integration_ingress_values" CHECK ("integration_ingress_buckets"."bucket" IN ('webhook','scheduler') AND "integration_ingress_buckets"."attempts" >= 0)
);

--> statement-breakpoint

ALTER TABLE integration_ingress_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_ingress_buckets FORCE ROW LEVEL SECURITY;
REVOKE ALL ON integration_ingress_buckets FROM app_user;

CREATE OR REPLACE FUNCTION take_integration_ingress(p_bucket text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE total integer;
BEGIN
  IF p_bucket NOT IN ('webhook','scheduler') THEN RETURN false; END IF;
  INSERT INTO public.integration_ingress_buckets (bucket, window_at, attempts) VALUES (p_bucket, clock_timestamp(), 1)
  ON CONFLICT (bucket) DO UPDATE SET
    attempts = CASE WHEN integration_ingress_buckets.window_at <= clock_timestamp() - interval '1 minute' THEN 1 ELSE LEAST(integration_ingress_buckets.attempts + 1, 601) END,
    window_at = CASE WHEN integration_ingress_buckets.window_at <= clock_timestamp() - interval '1 minute' THEN clock_timestamp() ELSE integration_ingress_buckets.window_at END
  RETURNING attempts INTO total;
  RETURN total <= CASE WHEN p_bucket = 'scheduler' THEN 2 ELSE 600 END;
END $$;
REVOKE ALL ON FUNCTION take_integration_ingress(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION take_integration_ingress(text) TO integration_scheduler;

CREATE OR REPLACE FUNCTION enqueue_integration_webhook(p_event uuid, p_item uuid, p_kind text, p_account uuid, p_ids uuid[])
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE connection public.external_connections%ROWTYPE; event_payload jsonb; existing jsonb;
BEGIN
  IF p_kind NOT IN ('transactions/created','transactions/updated','transactions/deleted','item/created','item/updated','item/deleted','item/error','item/waiting_user_input','item/login_succeeded')
    OR cardinality(p_ids) > 500 OR (p_kind LIKE 'transactions/%' AND p_account IS NULL) THEN
    RAISE EXCEPTION 'INTEGRATION_EVENT_INVALID';
  END IF;
  SELECT * INTO connection FROM public.external_connections WHERE item_id = p_item;
  IF NOT FOUND THEN RETURN false; END IF;
  event_payload = jsonb_build_object('event', p_kind, 'accountId', p_account, 'transactionIds', to_jsonb(coalesce(p_ids, ARRAY[]::uuid[])));
  INSERT INTO public.integration_jobs (user_id, connection_id, idempotency_key, payload)
    VALUES (connection.user_id, connection.id, 'event:' || p_event::text, event_payload)
    ON CONFLICT (connection_id, idempotency_key) DO NOTHING;
  SELECT payload INTO existing FROM public.integration_jobs WHERE connection_id = connection.id AND idempotency_key = 'event:' || p_event::text;
  IF existing IS DISTINCT FROM event_payload THEN RAISE EXCEPTION 'INTEGRATION_EVENT_CONFLICT'; END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION enqueue_integration_webhook(uuid, uuid, text, uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION enqueue_integration_webhook(uuid, uuid, text, uuid, uuid[]) TO integration_scheduler;

CREATE OR REPLACE FUNCTION enqueue_integration_recovery()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE total integer;
BEGIN
  INSERT INTO public.integration_jobs (user_id, connection_id, idempotency_key, payload)
  SELECT c.user_id, c.id, 'recovery:' || to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD'), '{}'::jsonb
    FROM public.external_connections c WHERE c.status = 'active'
    AND (c.last_fetched_at IS NULL OR c.last_fetched_at < clock_timestamp() - interval '6 hours')
    ORDER BY c.last_fetched_at NULLS FIRST, c.id LIMIT 20
    ON CONFLICT (connection_id, idempotency_key) DO NOTHING;
  GET DIAGNOSTICS total = ROW_COUNT;
  RETURN total;
END $$;
REVOKE ALL ON FUNCTION enqueue_integration_recovery() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION enqueue_integration_recovery() TO integration_scheduler;
