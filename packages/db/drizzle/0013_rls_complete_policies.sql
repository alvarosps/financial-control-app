-- Manual migration (psql, not journaled).
-- Applied: 2026-07-09
--
-- Real RLS, step 1/2: complete the policy set.
--   - credit_card_bills / account_balance_snapshots: replace allow-all
--     policies with ownership through accounts.user_id.
--   - audit_log: explicit WITH CHECK.
--   - 7 previously uncovered user-data tables gain RLS + policies.
-- Test DB converges via packages/db/src/sql/triggers-and-rls.sql.

ALTER TABLE user_profiles               ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_shares              ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_card_configs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE loan_configs                ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_loan_configs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE borrowed_cards              ENABLE ROW LEVEL SECURITY;
ALTER TABLE income_source_configs       ENABLE ROW LEVEL SECURITY;

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

DROP POLICY IF EXISTS audit_log_user_isolation ON audit_log;
CREATE POLICY audit_log_user_isolation ON audit_log
  USING (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

DROP POLICY IF EXISTS user_profiles_isolation ON user_profiles;
CREATE POLICY user_profiles_isolation ON user_profiles
  USING (
    id = current_setting('app.current_user_id', true)::uuid
    OR auth_user_id = current_setting('app.current_auth_user_id', true)
  )
  WITH CHECK (id = current_setting('app.current_user_id', true)::uuid);

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
