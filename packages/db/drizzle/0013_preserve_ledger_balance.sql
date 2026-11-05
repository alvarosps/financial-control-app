-- Account balances remain the economic double-entry ledger; wallet cash uses cash_value_brl and wallet_cash_in_window.
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

