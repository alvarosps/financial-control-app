-- Manual migration: DB triggers and Row-Level Security
-- Applied: 2026-04-06
-- Covers audit issues: DB-H2 (updatedAt auto-update), DB-H3 (balance consistency), SEC-M2 (RLS)

-- ============================================================
-- DB-H3: Auto-recalculate currentBalance on transaction changes
-- ============================================================

CREATE OR REPLACE FUNCTION recalculate_account_balance(p_account_id uuid)
RETURNS void AS $$
DECLARE
  v_incoming numeric(12,2);
  v_outgoing numeric(12,2);
BEGIN
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

CREATE TRIGGER trg_recalculate_balance
  AFTER INSERT OR UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION trigger_recalculate_balance();

-- ============================================================
-- DB-H2: Auto-update updatedAt on row modification
-- ============================================================

CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_updated_at_accounts BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER trg_updated_at_transactions BEFORE UPDATE ON transactions FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER trg_updated_at_scheduled_transactions BEFORE UPDATE ON scheduled_transactions FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER trg_updated_at_credit_card_configs BEFORE UPDATE ON credit_card_configs FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER trg_updated_at_credit_card_bills BEFORE UPDATE ON credit_card_bills FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER trg_updated_at_loan_configs BEFORE UPDATE ON loan_configs FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER trg_updated_at_family_loan_configs BEFORE UPDATE ON family_loan_configs FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER trg_updated_at_income_source_configs BEFORE UPDATE ON income_source_configs FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER trg_updated_at_categories BEFORE UPDATE ON categories FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER trg_updated_at_month_closings BEFORE UPDATE ON month_closings FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER trg_updated_at_simulation_scenarios BEFORE UPDATE ON simulation_scenarios FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ============================================================
-- SEC-M2: Row-Level Security (RLS)
-- ============================================================
-- Note: RLS is enabled but policies use current_setting('app.current_user_id').
-- The app currently connects as 'postgres' superuser which bypasses RLS.
-- For full enforcement, switch to a dedicated app user role.

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_card_bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE month_closings ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE simulation_scenarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE materialization_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_balance_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY accounts_user_isolation ON accounts
  USING (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

CREATE POLICY transactions_user_isolation ON transactions
  USING (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

CREATE POLICY scheduled_tx_user_isolation ON scheduled_transactions
  USING (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

CREATE POLICY categories_user_isolation ON categories
  USING (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

CREATE POLICY month_closings_user_isolation ON month_closings
  USING (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

CREATE POLICY audit_log_user_isolation ON audit_log
  USING (user_id = current_setting('app.current_user_id', true)::uuid);

CREATE POLICY sim_scenarios_user_isolation ON simulation_scenarios
  USING (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

CREATE POLICY mat_status_user_isolation ON materialization_status
  USING (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

CREATE POLICY ccb_allow_all ON credit_card_bills USING (true) WITH CHECK (true);
CREATE POLICY abs_allow_all ON account_balance_snapshots USING (true) WITH CHECK (true);
