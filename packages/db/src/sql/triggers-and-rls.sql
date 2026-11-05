-- Canonical idempotent SQL for DB functions, triggers, and Row-Level Security.
--
-- This file is the SINGLE SOURCE OF TRUTH for the database's non-DDL objects
-- that Drizzle does not own (plpgsql functions, triggers, RLS policies).
--
-- Who uses this file:
--   - scripts/test-db-reset.sh  → applies this file after `drizzle-kit push`.
--   - Prod migration history (packages/db/drizzle/0004_triggers_and_rls.sql
--     etc.) is frozen; future changes go in new migrations AND update this
--     file so that `test-db-reset` produces the same end state as a full
--     migration replay.
--
-- Rule: if you add/change a trigger, function, or RLS policy in a new
--       migration, you MUST update this file too. CI runs
--       `scripts/check-canonical-sql.sh`, which compares a full migration
--       replay with a Drizzle push plus this canonical SQL on fresh test DBs.
--
-- All statements are idempotent (CREATE OR REPLACE / DROP IF EXISTS + CREATE).

-- ============================================================
-- Functions
-- ============================================================

CREATE OR REPLACE FUNCTION cash_value_brl(p_amount numeric, p_currency text, p_cash numeric)
RETURNS numeric AS $$
  SELECT CASE WHEN p_cash IS NOT NULL THEN p_cash WHEN p_currency = 'BRL' THEN p_amount ELSE NULL END;
$$ LANGUAGE sql IMMUTABLE;
CREATE OR REPLACE FUNCTION cash_movement_day(p_date date, p_settlement timestamptz)
RETURNS date AS $$
  SELECT COALESCE((p_settlement AT TIME ZONE 'America/Sao_Paulo')::date, p_date);
$$ LANGUAGE sql IMMUTABLE;
CREATE OR REPLACE FUNCTION wallet_cash_in_window(p transactions, p_anchor timestamptz, p_basis text, p_as_of timestamptz, p_include_assumed boolean DEFAULT false)
RETURNS boolean AS $$
  SELECT p.is_paid AND NOT p.is_reversed AND p.reverses_transaction_id IS NULL
    AND (p_include_assumed OR p.settlement_source <> 'date_assumed')
    AND cash_movement_day(p.date, p.settlement_date) <= (p_as_of AT TIME ZONE 'America/Sao_Paulo')::date
    AND (p.settlement_date IS NULL OR p.settlement_date <= p_as_of)
    AND CASE WHEN p_basis = 'effective' THEN p.settlement_date > p_anchor ELSE p.paid_at > p_anchor END
    AND (p.domain_type IS NULL OR p.domain_type::text NOT IN (
      'family_loan_installment','family_loan_fixed_charge','family_loan_expense','family_loan_discount'
    ));
$$ LANGUAGE sql IMMUTABLE;
-- Economic ledger cache, not available cash. WalletCashService uses the cash functions above.
CREATE OR REPLACE FUNCTION recalculate_account_balance(p_account_id uuid)
RETURNS void AS $$
DECLARE
  v_incoming numeric(12,2);
  v_outgoing numeric(12,2);
BEGIN
  -- Serialize concurrent recalculations of the SAME account: the row lock is
  -- acquired before computing SUMs. Without this, two transactions can read
  -- stale sums and the second write wins with the wrong balance.
  PERFORM 1 FROM accounts WHERE id = p_account_id FOR UPDATE;

  SELECT COALESCE(SUM(amount), 0) INTO v_incoming
  FROM transactions
  WHERE destination_account_id = p_account_id AND is_reversed = false;

  SELECT COALESCE(SUM(amount), 0) INTO v_outgoing
  FROM transactions
  WHERE source_account_id = p_account_id AND is_reversed = false;

  UPDATE accounts
  SET current_balance = (v_incoming - v_outgoing),
      updated_at = NOW()
  WHERE id = p_account_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION trigger_recalculate_balance()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'UPDATE' THEN
    PERFORM recalculate_account_balance(OLD.source_account_id);
    IF OLD.destination_account_id != OLD.source_account_id THEN
      PERFORM recalculate_account_balance(OLD.destination_account_id);
    END IF;
  END IF;

  IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    PERFORM recalculate_account_balance(NEW.source_account_id);
    IF NEW.destination_account_id != NEW.source_account_id THEN
      PERFORM recalculate_account_balance(NEW.destination_account_id);
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- Triggers (drop & recreate for idempotency)
-- ============================================================

DROP TRIGGER IF EXISTS trg_recalculate_balance ON transactions;
CREATE TRIGGER trg_recalculate_balance
  AFTER INSERT OR UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION trigger_recalculate_balance();

-- updated_at triggers, one per table with an updated_at column.
DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    'accounts','transactions','scheduled_transactions','credit_card_configs',
    'credit_card_bills','loan_configs','family_loan_configs',
    'income_source_configs','categories','month_closings','simulation_scenarios',
    'user_profiles','fatura_imports','fatura_match_rules'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_updated_at_%I ON %I', tbl, tbl);
    EXECUTE format(
      'CREATE TRIGGER trg_updated_at_%I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at()',
      tbl, tbl
    );
  END LOOP;
END $$;

-- ============================================================
-- Row-Level Security
-- ============================================================

ALTER TABLE accounts                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions                ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_transactions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_card_bills           ENABLE ROW LEVEL SECURITY;
ALTER TABLE month_closings              ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE simulation_scenarios        ENABLE ROW LEVEL SECURITY;
ALTER TABLE materialization_status      ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_balance_snapshots   ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_profiles               ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_shares              ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_card_configs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE loan_configs                ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_loan_configs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE borrowed_cards              ENABLE ROW LEVEL SECURITY;
ALTER TABLE income_source_configs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE fatura_imports              ENABLE ROW LEVEL SECURITY;
ALTER TABLE fatura_match_rules           ENABLE ROW LEVEL SECURITY;

-- Intentional exclusions:
--   - fx_rates is global reference data shared by every user.
--   - better-auth tables ("user", "session", "account", "verification") run
--     outside the app.current_user_id GUC and isolate through session tokens.
-- Explicitly converge environments where RLS was enabled out-of-band. Without
-- these statements, app_user receives the implicit deny-all policy before
-- Better Auth can establish a session.
ALTER TABLE public."user"         NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public."account"      NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public."session"      NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public."verification" NO FORCE ROW LEVEL SECURITY;

ALTER TABLE public."user"         DISABLE ROW LEVEL SECURITY;
ALTER TABLE public."account"      DISABLE ROW LEVEL SECURITY;
ALTER TABLE public."session"      DISABLE ROW LEVEL SECURITY;
ALTER TABLE public."verification" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS accounts_user_isolation ON accounts;
CREATE POLICY accounts_user_isolation ON accounts
  USING (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

DROP POLICY IF EXISTS transactions_user_isolation ON transactions;
CREATE POLICY transactions_user_isolation ON transactions
  USING (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

DROP POLICY IF EXISTS scheduled_tx_user_isolation ON scheduled_transactions;
CREATE POLICY scheduled_tx_user_isolation ON scheduled_transactions
  USING (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

DROP POLICY IF EXISTS categories_user_isolation ON categories;
CREATE POLICY categories_user_isolation ON categories
  USING (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

DROP POLICY IF EXISTS month_closings_user_isolation ON month_closings;
CREATE POLICY month_closings_user_isolation ON month_closings
  USING (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

DROP POLICY IF EXISTS audit_log_user_isolation ON audit_log;
CREATE POLICY audit_log_user_isolation ON audit_log
  USING (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

DROP POLICY IF EXISTS sim_scenarios_user_isolation ON simulation_scenarios;
CREATE POLICY sim_scenarios_user_isolation ON simulation_scenarios
  USING (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

DROP POLICY IF EXISTS mat_status_user_isolation ON materialization_status;
CREATE POLICY mat_status_user_isolation ON materialization_status
  USING (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

-- Tables with indirect user ownership through accounts.

DROP POLICY IF EXISTS ccb_allow_all ON credit_card_bills;
DROP POLICY IF EXISTS ccb_user_isolation ON credit_card_bills;
CREATE POLICY ccb_user_isolation ON credit_card_bills
  USING (EXISTS (
    SELECT 1 FROM accounts a
    WHERE a.id = credit_card_bills.credit_card_account_id
      AND a.user_id = current_setting('app.current_user_id', true)::uuid))
  WITH CHECK (EXISTS (
    SELECT 1 FROM accounts a
    WHERE a.id = credit_card_bills.credit_card_account_id
      AND a.user_id = current_setting('app.current_user_id', true)::uuid));

DROP POLICY IF EXISTS abs_allow_all ON account_balance_snapshots;
DROP POLICY IF EXISTS abs_user_isolation ON account_balance_snapshots;
CREATE POLICY abs_user_isolation ON account_balance_snapshots
  USING (EXISTS (
    SELECT 1 FROM accounts a
    WHERE a.id = account_balance_snapshots.account_id
      AND a.user_id = current_setting('app.current_user_id', true)::uuid))
  WITH CHECK (EXISTS (
    SELECT 1 FROM accounts a
    WHERE a.id = account_balance_snapshots.account_id
      AND a.user_id = current_setting('app.current_user_id', true)::uuid));

-- user_profiles has an extra app.current_auth_user_id arm for the session
-- bootstrap lookup that resolves the app profile from the better-auth user id
-- before app.current_user_id is known.
DROP POLICY IF EXISTS user_profiles_isolation ON user_profiles;
CREATE POLICY user_profiles_isolation ON user_profiles
  USING (
    id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    OR auth_user_id = current_setting('app.current_auth_user_id', true)
  )
  WITH CHECK (
    id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  );

DROP POLICY IF EXISTS account_shares_isolation ON account_shares;
CREATE POLICY account_shares_isolation ON account_shares
  USING (
    shared_with_user_id = current_setting('app.current_user_id', true)::uuid
    OR EXISTS (
      SELECT 1 FROM accounts a
      WHERE a.id = account_shares.account_id
        AND a.user_id = current_setting('app.current_user_id', true)::uuid)
  )
  WITH CHECK (EXISTS (
    SELECT 1 FROM accounts a
    WHERE a.id = account_shares.account_id
      AND a.user_id = current_setting('app.current_user_id', true)::uuid));

DROP POLICY IF EXISTS ccc_user_isolation ON credit_card_configs;
CREATE POLICY ccc_user_isolation ON credit_card_configs
  USING (EXISTS (
    SELECT 1 FROM accounts a
    WHERE a.id = credit_card_configs.account_id
      AND a.user_id = current_setting('app.current_user_id', true)::uuid))
  WITH CHECK (EXISTS (
    SELECT 1 FROM accounts a
    WHERE a.id = credit_card_configs.account_id
      AND a.user_id = current_setting('app.current_user_id', true)::uuid));

DROP POLICY IF EXISTS lc_user_isolation ON loan_configs;
CREATE POLICY lc_user_isolation ON loan_configs
  USING (EXISTS (
    SELECT 1 FROM accounts a
    WHERE a.id = loan_configs.account_id
      AND a.user_id = current_setting('app.current_user_id', true)::uuid))
  WITH CHECK (EXISTS (
    SELECT 1 FROM accounts a
    WHERE a.id = loan_configs.account_id
      AND a.user_id = current_setting('app.current_user_id', true)::uuid));

DROP POLICY IF EXISTS flc_user_isolation ON family_loan_configs;
CREATE POLICY flc_user_isolation ON family_loan_configs
  USING (EXISTS (
    SELECT 1 FROM accounts a
    WHERE a.id = family_loan_configs.account_id
      AND a.user_id = current_setting('app.current_user_id', true)::uuid))
  WITH CHECK (EXISTS (
    SELECT 1 FROM accounts a
    WHERE a.id = family_loan_configs.account_id
      AND a.user_id = current_setting('app.current_user_id', true)::uuid));

DROP POLICY IF EXISTS bc_user_isolation ON borrowed_cards;
CREATE POLICY bc_user_isolation ON borrowed_cards
  USING (EXISTS (
    SELECT 1 FROM family_loan_configs flc
    JOIN accounts a ON a.id = flc.account_id
    WHERE flc.id = borrowed_cards.family_loan_config_id
      AND a.user_id = current_setting('app.current_user_id', true)::uuid))
  WITH CHECK (EXISTS (
    SELECT 1 FROM family_loan_configs flc
    JOIN accounts a ON a.id = flc.account_id
    WHERE flc.id = borrowed_cards.family_loan_config_id
      AND a.user_id = current_setting('app.current_user_id', true)::uuid));

DROP POLICY IF EXISTS isc_user_isolation ON income_source_configs;
CREATE POLICY isc_user_isolation ON income_source_configs
  USING (EXISTS (
    SELECT 1 FROM accounts a
    WHERE a.id = income_source_configs.account_id
      AND a.user_id = current_setting('app.current_user_id', true)::uuid))
  WITH CHECK (EXISTS (
    SELECT 1 FROM accounts a
    WHERE a.id = income_source_configs.account_id
      AND a.user_id = current_setting('app.current_user_id', true)::uuid));

DROP POLICY IF EXISTS fatura_imports_user_isolation ON fatura_imports;
CREATE POLICY fatura_imports_user_isolation ON fatura_imports
  USING (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

DROP POLICY IF EXISTS fatura_match_rules_user_isolation ON fatura_match_rules;
CREATE POLICY fatura_match_rules_user_isolation ON fatura_match_rules
  USING (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

-- ============================================================
-- app_user role (application runtime; RLS enforced)
-- ============================================================
-- The web runtime connects as app_user (APP_DATABASE_URL). This repository
-- creates the role as NOLOGIN; enabling LOGIN + password is a manual step per
-- environment:
--   dev/test local:  ALTER ROLE app_user LOGIN PASSWORD 'app_user';
--   prod (Supabase): ALTER ROLE app_user LOGIN PASSWORD '<strong password>';
-- Tooling (drizzle-kit, scripts, backups, tests) keeps using postgres
-- (superuser) via DATABASE_URL/TEST_DATABASE_URL and bypasses RLS.

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;

-- FORCE makes policies apply even for table owners. Supabase postgres has
-- BYPASSRLS, so superuser tooling still works.
ALTER TABLE accounts                   FORCE ROW LEVEL SECURITY;
ALTER TABLE transactions               FORCE ROW LEVEL SECURITY;
ALTER TABLE scheduled_transactions     FORCE ROW LEVEL SECURITY;
ALTER TABLE categories                 FORCE ROW LEVEL SECURITY;
ALTER TABLE credit_card_bills          FORCE ROW LEVEL SECURITY;
ALTER TABLE month_closings             FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_log                  FORCE ROW LEVEL SECURITY;
ALTER TABLE simulation_scenarios       FORCE ROW LEVEL SECURITY;
ALTER TABLE materialization_status     FORCE ROW LEVEL SECURITY;
ALTER TABLE account_balance_snapshots  FORCE ROW LEVEL SECURITY;
ALTER TABLE user_profiles              FORCE ROW LEVEL SECURITY;
ALTER TABLE account_shares             FORCE ROW LEVEL SECURITY;
ALTER TABLE credit_card_configs        FORCE ROW LEVEL SECURITY;
ALTER TABLE loan_configs               FORCE ROW LEVEL SECURITY;
ALTER TABLE family_loan_configs        FORCE ROW LEVEL SECURITY;
ALTER TABLE borrowed_cards             FORCE ROW LEVEL SECURITY;
ALTER TABLE income_source_configs      FORCE ROW LEVEL SECURITY;
ALTER TABLE fatura_imports             FORCE ROW LEVEL SECURITY;
ALTER TABLE fatura_match_rules          FORCE ROW LEVEL SECURITY;

-- S03: payroll allocations keep both transaction owners and serialize the sum.
CREATE OR REPLACE FUNCTION validate_loan_income_source()
RETURNS trigger AS $$
BEGIN
  IF NEW.income_source_account_id IS NOT NULL AND (
    NEW.payment_method IS DISTINCT FROM 'payroll' OR NOT EXISTS (
      SELECT 1 FROM accounts loan JOIN accounts income ON income.user_id = loan.user_id
      WHERE loan.id = NEW.account_id AND income.id = NEW.income_source_account_id
        AND income.type = 'revenue'
    )
  ) THEN
    RAISE EXCEPTION 'Invalid payroll income source' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_loan_income_source ON loan_configs;
CREATE TRIGGER trg_loan_income_source BEFORE INSERT OR UPDATE ON loan_configs
FOR EACH ROW EXECUTE FUNCTION validate_loan_income_source();

CREATE OR REPLACE FUNCTION validate_payroll_deduction()
RETURNS trigger AS $$
DECLARE
  income transactions%ROWTYPE;
  installment transactions%ROWTYPE;
  allocated numeric;
BEGIN
  SELECT * INTO income FROM transactions
  WHERE id = NEW.income_transaction_id AND user_id = NEW.user_id FOR UPDATE;
  IF NOT FOUND OR income.is_reversed OR income.domain_type NOT IN (
    'income_clt','income_pj','income_freelancer','income_rental','income_family_loan','income_other'
  ) OR income.domain_type IS NULL THEN
    RAISE EXCEPTION 'Invalid payroll income occurrence' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO installment FROM transactions
  WHERE id = NEW.loan_transaction_id AND user_id = NEW.user_id FOR UPDATE;
  IF NOT FOUND OR installment.is_reversed OR installment.domain_type IS DISTINCT FROM 'loan_payment'
    OR installment.currency <> 'BRL' OR installment.amount <> NEW.amount THEN
    RAISE EXCEPTION 'Invalid payroll loan occurrence' USING ERRCODE = '23514';
  END IF;
  IF NEW.reversed_at IS NULL THEN
    IF income.currency = 'BRL' AND income.amount <> NEW.gross_income_brl THEN
      RAISE EXCEPTION 'Payroll gross differs from economic income' USING ERRCODE = '23514';
    END IF;
    SELECT COALESCE(SUM(amount), 0) INTO allocated FROM payroll_deductions
    WHERE income_transaction_id = NEW.income_transaction_id AND reversed_at IS NULL AND id <> NEW.id;
    IF allocated + NEW.amount > NEW.gross_income_brl OR EXISTS (
      SELECT 1 FROM payroll_deductions WHERE income_transaction_id = NEW.income_transaction_id
      AND reversed_at IS NULL AND id <> NEW.id AND gross_income_brl <> NEW.gross_income_brl
    ) THEN
      RAISE EXCEPTION 'Payroll deductions exceed or disagree on income' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payroll_deduction ON payroll_deductions;
CREATE TRIGGER trg_payroll_deduction BEFORE INSERT OR UPDATE ON payroll_deductions
FOR EACH ROW EXECUTE FUNCTION validate_payroll_deduction();

ALTER TABLE payroll_deductions ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_deductions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payroll_user_isolation ON payroll_deductions;
CREATE POLICY payroll_user_isolation ON payroll_deductions
  USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON payroll_deductions TO app_user;

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
DROP TRIGGER IF EXISTS trg_protect_payroll_transaction ON transactions;
CREATE TRIGGER trg_protect_payroll_transaction BEFORE UPDATE ON transactions
FOR EACH ROW EXECUTE FUNCTION protect_payroll_transaction();
CREATE OR REPLACE FUNCTION protect_payroll_loan_binding()
RETURNS trigger AS $$
BEGIN
  IF (NEW.payment_method, NEW.income_source_account_id, NEW.account_id)
    IS DISTINCT FROM (OLD.payment_method, OLD.income_source_account_id, OLD.account_id)
    AND EXISTS (
      SELECT 1 FROM payroll_deductions p JOIN transactions t ON t.id = p.loan_transaction_id
      WHERE t.destination_account_id = OLD.account_id AND p.reversed_at IS NULL
    ) THEN
    RAISE EXCEPTION 'Undo payroll before changing its loan binding' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_protect_payroll_loan_binding ON loan_configs;
CREATE TRIGGER trg_protect_payroll_loan_binding BEFORE UPDATE ON loan_configs
FOR EACH ROW EXECUTE FUNCTION protect_payroll_loan_binding();

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
  IF TG_OP = 'UPDATE' THEN
    IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
      RAISE EXCEPTION 'Revoked purchase links are immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.revoked_at IS NOT NULL THEN RETURN NEW; END IF;
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
      AND ((domain_type = 'credit_card_refund') = (observation.kind = 'refund')) AND (
        (domain_type = 'credit_card_installment' AND NEW.billing_month IS NULL) OR
        (domain_type IN ('credit_card_fixed_charge','credit_card_expense','credit_card_refund') AND NEW.billing_month IS NOT NULL)
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

ALTER TABLE budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE budgets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS budgets_owner ON budgets;
CREATE POLICY budgets_owner ON budgets FOR ALL USING (user_id = current_setting('app.current_user_id', true)::uuid) WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);
GRANT SELECT, INSERT ON budgets TO app_user;
GRANT UPDATE (limit_amount, version, updated_at) ON budgets TO app_user;
CREATE OR REPLACE FUNCTION validate_budget_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND ((to_jsonb(NEW) - ARRAY['limit_amount','version','updated_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['limit_amount','version','updated_at']) OR NEW.version <> OLD.version + 1) THEN
    RAISE EXCEPTION 'Budget scope is immutable and version must advance';
  END IF;
  IF NEW.category_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM categories WHERE id=NEW.category_id AND user_id=NEW.user_id AND type='expense') THEN
    RAISE EXCEPTION 'Budget category must belong to owner';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS budgets_validate ON budgets;
CREATE TRIGGER budgets_validate BEFORE INSERT OR UPDATE ON budgets FOR EACH ROW EXECUTE FUNCTION validate_budget_owner();
DROP TRIGGER IF EXISTS budgets_updated_at ON budgets;
CREATE TRIGGER budgets_updated_at BEFORE UPDATE ON budgets FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

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
  IF (session_user='app_user' OR current_setting('role',true)='app_user') AND
    nullif(current_setting('app.current_user_id',true),'')::uuid IS DISTINCT FROM owner_id THEN
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
    IF owner_id IS NULL AND TG_OP='DELETE' AND account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM accounts WHERE id=account_id) THEN RETURN OLD; END IF;
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
          OR (t.scheduled_transaction_id=(row_data->>'schedule_id')::uuid AND (row_data->>'billing_month' IS NULL OR (t.billing_month=(row_data->>'billing_month')::int AND t.billing_year=(row_data->>'billing_year')::int))));
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
