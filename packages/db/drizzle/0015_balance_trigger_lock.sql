-- Manual migration (psql, pattern 0009/0011/0012 -- NOT journaled).
-- Applied: 2026-07-09
--
-- Fixes lost update in recalculate_account_balance: SUMs were computed before
-- the accounts row lock was acquired by UPDATE, so concurrent transactions
-- could read stale sums and the last write won with a wrong balance. Now the
-- lock (FOR UPDATE) happens before the SUMs.
-- CREATE OR REPLACE is idempotent; test DB converges via triggers-and-rls.sql.

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
