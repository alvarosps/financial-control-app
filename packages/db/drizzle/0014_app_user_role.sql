-- Manual migration (psql, not journaled).
-- Applied: 2026-07-09
--
-- Real RLS, step 2/2 (database side): non-superuser app_user role, per-table
-- grants, and FORCE ROW LEVEL SECURITY. LOGIN/password is a manual step per
-- environment and must not be committed. The runtime must connect through
-- APP_DATABASE_URL for these policies to enforce isolation.

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
