ALTER TABLE "external_accounts" ADD COLUMN "movement_revision" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
DROP FUNCTION IF EXISTS enqueue_integration_webhook(uuid, uuid, text, uuid, uuid[]);
CREATE OR REPLACE FUNCTION enqueue_integration_webhook(p_event uuid, p_item uuid, p_kind text, p_account uuid, p_ids uuid[], p_created timestamptz DEFAULT NULL, p_min_date date DEFAULT NULL)
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
  IF p_created IS NOT NULL THEN event_payload = event_payload || jsonb_build_object('transactionsCreatedAtFrom', to_char(p_created AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')); END IF;
  IF p_min_date IS NOT NULL THEN event_payload = event_payload || jsonb_build_object('transactionsMinDate', p_min_date::text); END IF;
  INSERT INTO public.integration_jobs (user_id, connection_id, idempotency_key, payload)
    VALUES (connection.user_id, connection.id, 'event:' || p_event::text, event_payload)
    ON CONFLICT (connection_id, idempotency_key) DO NOTHING;
  SELECT payload INTO existing FROM public.integration_jobs WHERE connection_id = connection.id AND idempotency_key = 'event:' || p_event::text;
  IF existing IS DISTINCT FROM event_payload THEN RAISE EXCEPTION 'INTEGRATION_EVENT_CONFLICT'; END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION enqueue_integration_webhook(uuid, uuid, text, uuid, uuid[], timestamptz, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION enqueue_integration_webhook(uuid, uuid, text, uuid, uuid[], timestamptz, date) TO integration_scheduler;
