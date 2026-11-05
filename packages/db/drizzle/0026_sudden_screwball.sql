CREATE TABLE "month_closing_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"month" integer NOT NULL,
	"year" integer NOT NULL,
	"revision" integer NOT NULL,
	"action" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "month_closing_version_unique" UNIQUE("user_id","month","year","revision"),
	CONSTRAINT "month_closing_version_values" CHECK ("month_closing_versions"."month" BETWEEN 1 AND 12 AND "month_closing_versions"."year" > 0 AND "month_closing_versions"."revision" > 0 AND "month_closing_versions"."action" IN ('closed','reopened') AND length(btrim("month_closing_versions"."reason")) >= 3 AND jsonb_typeof("month_closing_versions"."snapshot") = 'object')
);
--> statement-breakpoint
ALTER TABLE "month_closings" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "month_closing_versions" ADD CONSTRAINT "month_closing_versions_user_id_user_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_profiles"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE month_closing_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE month_closing_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS month_closing_versions_owner ON month_closing_versions;
CREATE POLICY month_closing_versions_owner ON month_closing_versions FOR ALL
  USING (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);
GRANT SELECT, INSERT ON month_closing_versions TO app_user;

CREATE OR REPLACE FUNCTION financial_transaction_dates(row_data jsonb) RETURNS date[]
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT ARRAY[
    (row_data->>'date')::date,
    CASE WHEN row_data->>'billing_month' IS NOT NULL AND row_data->>'billing_year' IS NOT NULL
      THEN make_date((row_data->>'billing_year')::int,(row_data->>'billing_month')::int,1) END,
    ((row_data->>'settlement_date')::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date
  ];
$$;

CREATE OR REPLACE FUNCTION assert_financial_period_open(owner_id uuid, period_dates date[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF (session_user='app_user' OR current_setting('role',true)='app_user') AND nullif(current_setting('app.current_user_id',true),'') IS NOT NULL
    AND current_setting('app.current_user_id',true)::uuid <> owner_id THEN
    RAISE EXCEPTION 'Financial period owner mismatch';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id::text,0));
  IF EXISTS (SELECT 1 FROM month_closings mc CROSS JOIN unnest(period_dates) d
    WHERE mc.user_id=owner_id AND mc.status='closed'
      AND mc.year=extract(year FROM d) AND mc.month=extract(month FROM d)) THEN
    RAISE EXCEPTION 'Financial period is closed; explicit reopening required';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION assert_financial_period_open(uuid,date[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION assert_financial_period_open(uuid,date[]) TO app_user;

CREATE OR REPLACE FUNCTION guard_financial_period() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  row_data jsonb;
  old_data jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) ELSE NULL END;
  new_data jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) ELSE NULL END;
  owner_id uuid;
  account_id uuid;
  related_dates date[];
BEGIN
  IF TG_OP='UPDATE' AND (old_data - 'updated_at') IS NOT DISTINCT FROM (new_data - 'updated_at') THEN RETURN NEW; END IF;
  FOR row_data IN SELECT value FROM jsonb_array_elements(jsonb_build_array(old_data,new_data)) WHERE value <> 'null'::jsonb LOOP
    owner_id := (row_data->>'user_id')::uuid;
    account_id := coalesce(row_data->>'account_id',row_data->>'credit_card_account_id')::uuid;
    IF TG_TABLE_NAME='accounts' THEN account_id := (row_data->>'id')::uuid; END IF;
    IF owner_id IS NULL AND account_id IS NOT NULL THEN SELECT user_id INTO owner_id FROM accounts WHERE id=account_id; END IF;
    IF owner_id IS NULL THEN RAISE EXCEPTION 'Financial period owner is missing'; END IF;
    -- A deleted user's own cascading data may be purged; financial edits may not.
    IF TG_OP='DELETE' AND NOT EXISTS (SELECT 1 FROM user_profiles WHERE id=owner_id) THEN RETURN OLD; END IF;
    PERFORM assert_financial_period_open(owner_id,ARRAY[]::date[]);

    IF TG_TABLE_NAME='month_closing_versions' THEN
      IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Closing history is immutable'; END IF;
    ELSIF TG_TABLE_NAME='month_closings' THEN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Closing history cannot be deleted'; END IF;
      IF TG_OP='UPDATE' AND OLD.status='closed' AND (NEW.status='closed' OR NEW.revision<=OLD.revision) THEN
        RAISE EXCEPTION 'Closed snapshot requires a versioned reopening';
      END IF;
      IF TG_OP='UPDATE' AND (NEW.user_id,NEW.month,NEW.year) IS DISTINCT FROM (OLD.user_id,OLD.month,OLD.year) THEN RAISE EXCEPTION 'Closing identity is immutable'; END IF;
      IF (new_data->>'revision')::int > 0 AND NOT EXISTS (SELECT 1 FROM month_closing_versions v
        WHERE v.user_id=owner_id AND v.month=(new_data->>'month')::int AND v.year=(new_data->>'year')::int AND v.revision=(new_data->>'revision')::int
          AND v.action=CASE WHEN new_data->>'status'='closed' THEN 'closed' ELSE 'reopened' END) THEN
        RAISE EXCEPTION 'Closing revision requires immutable history';
      END IF;
    ELSIF TG_TABLE_NAME='transactions' THEN
      PERFORM assert_financial_period_open(owner_id,financial_transaction_dates(row_data));
    ELSIF TG_TABLE_NAME IN ('credit_card_bills','account_balance_snapshots','budgets') THEN
      PERFORM assert_financial_period_open(owner_id,ARRAY[make_date((row_data->>'year')::int,(row_data->>'month')::int,1)]);
    ELSIF TG_TABLE_NAME='fatura_imports' THEN
      IF row_data->>'status'='applied' THEN
        PERFORM assert_financial_period_open(owner_id,ARRAY[make_date((row_data->>'billing_year')::int,(row_data->>'billing_month')::int,1)]);
      END IF;
    ELSIF TG_TABLE_NAME IN ('purchase_ledger_links','bank_reconciliation_links','payroll_deductions') THEN
      PERFORM assert_financial_period_open(owner_id,financial_transaction_dates(row_data));
      SELECT array_agg(d) INTO related_dates FROM transactions t CROSS JOIN LATERAL unnest(financial_transaction_dates(to_jsonb(t))) d
        WHERE t.user_id=owner_id AND (t.id IN ((row_data->>'transaction_id')::uuid,(row_data->>'income_transaction_id')::uuid,(row_data->>'loan_transaction_id')::uuid)
          OR t.scheduled_transaction_id=(row_data->>'schedule_id')::uuid);
      PERFORM assert_financial_period_open(owner_id,related_dates);
    ELSIF TG_TABLE_NAME='scheduled_transactions' THEN
      IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND (old_data->'source_account_id',old_data->'destination_account_id',old_data->'user_id') IS DISTINCT FROM (new_data->'source_account_id',new_data->'destination_account_id',new_data->'user_id')) THEN
        SELECT array_agg(d) INTO related_dates FROM transactions t CROSS JOIN LATERAL unnest(financial_transaction_dates(to_jsonb(t))) d WHERE t.scheduled_transaction_id=(row_data->>'id')::uuid;
        PERFORM assert_financial_period_open(owner_id,related_dates);
      END IF;
    ELSIF TG_TABLE_NAME='accounts' THEN
      IF TG_OP='UPDATE' AND (old_data->'opening_balance',old_data->'opening_balance_anchor_at',old_data->'cash_anchor_basis') IS DISTINCT FROM (new_data->'opening_balance',new_data->'opening_balance_anchor_at',new_data->'cash_anchor_basis') THEN
        IF EXISTS (SELECT 1 FROM month_closings WHERE user_id=owner_id AND status='closed' AND
          (new_data->>'opening_balance_anchor_at' IS NULL OR make_date(year,month,1) + interval '1 month' > ((new_data->>'opening_balance_anchor_at')::timestamptz AT TIME ZONE 'America/Sao_Paulo'))) THEN
          RAISE EXCEPTION 'Financial period is closed; anchor must follow closed periods';
        END IF;
      END IF;
      IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND (old_data->'type',old_data->'currency',old_data->'user_id',old_data->'parent_account_id',old_data->'is_active') IS DISTINCT FROM (new_data->'type',new_data->'currency',new_data->'user_id',new_data->'parent_account_id',new_data->'is_active')) THEN
        SELECT array_agg(d) INTO related_dates FROM transactions t CROSS JOIN LATERAL unnest(financial_transaction_dates(to_jsonb(t))) d
          WHERE t.user_id=owner_id AND account_id IN (t.source_account_id,t.destination_account_id,t.receivable_account_id);
        PERFORM assert_financial_period_open(owner_id,related_dates);
      END IF;
    ELSIF TG_TABLE_NAME='categories' THEN
      SELECT array_agg(d) INTO related_dates FROM transactions t CROSS JOIN LATERAL unnest(financial_transaction_dates(to_jsonb(t))) d WHERE t.user_id=owner_id AND t.category_id=(row_data->>'id')::uuid;
      PERFORM assert_financial_period_open(owner_id,related_dates);
    ELSE
      -- Contract configuration has no effective-from version. Protect consumers
      -- in closed periods; current quote/CET evidence does not rewrite ledger data.
      IF TG_TABLE_NAME='loan_configs' AND TG_OP='UPDATE' AND
        (old_data - ARRAY['annual_cet','annual_cet_source','annual_cet_observed_on','payoff_quote_amount','payoff_quote_on','payoff_quote_valid_until','payoff_quote_source','economic_responsibility','updated_at']) IS NOT DISTINCT FROM
        (new_data - ARRAY['annual_cet','annual_cet_source','annual_cet_observed_on','payoff_quote_amount','payoff_quote_on','payoff_quote_valid_until','payoff_quote_source','economic_responsibility','updated_at']) THEN CONTINUE; END IF;
      SELECT array_agg(d) INTO related_dates FROM transactions t CROSS JOIN LATERAL unnest(financial_transaction_dates(to_jsonb(t))) d
        WHERE t.user_id=owner_id AND account_id IN (t.source_account_id,t.destination_account_id,t.receivable_account_id);
      PERFORM assert_financial_period_open(owner_id,related_dates);
    END IF;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['transactions','accounts','categories','credit_card_bills','account_balance_snapshots','budgets','fatura_imports','purchase_ledger_links','bank_reconciliation_links','payroll_deductions','scheduled_transactions','loan_configs','income_source_configs','credit_card_configs','family_loan_configs','borrowed_cards','month_closings','month_closing_versions'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS financial_period_guard ON %I',table_name);
    EXECUTE format('CREATE TRIGGER financial_period_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION guard_financial_period()',table_name);
  END LOOP;
END $$;
