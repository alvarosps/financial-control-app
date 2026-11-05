CREATE OR REPLACE FUNCTION cash_value_brl(p_amount numeric, p_currency text, p_cash numeric)
RETURNS numeric AS $$
  SELECT CASE WHEN p_cash IS NOT NULL THEN p_cash WHEN p_currency = 'BRL' THEN p_amount ELSE NULL END;
$$ LANGUAGE sql IMMUTABLE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION cash_movement_day(p_date date, p_settlement timestamptz)
RETURNS date AS $$
  SELECT COALESCE((p_settlement AT TIME ZONE 'America/Sao_Paulo')::date, p_date);
$$ LANGUAGE sql IMMUTABLE;
--> statement-breakpoint
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
--> statement-breakpoint
CREATE OR REPLACE FUNCTION recalculate_account_balance(p_account_id uuid)
RETURNS void AS $$
DECLARE
  wallet accounts%ROWTYPE;
  v_incoming numeric(12,2);
  v_outgoing numeric(12,2);
BEGIN
  SELECT * INTO wallet FROM accounts WHERE id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF wallet.type = 'checking' AND wallet.currency = 'BRL' THEN
    SELECT
      COALESCE(SUM(CASE WHEN destination_account_id = p_account_id THEN cash_value_brl(amount, currency, cash_amount) ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN source_account_id = p_account_id THEN cash_value_brl(amount, currency, cash_amount) ELSE 0 END), 0)
      INTO v_incoming, v_outgoing
    FROM transactions t WHERE t.user_id = wallet.user_id
      AND (t.source_account_id = p_account_id OR t.destination_account_id = p_account_id)
      AND wallet_cash_in_window(t, COALESCE(wallet.opening_balance_anchor_at, '1970-01-01Z'::timestamptz), wallet.cash_anchor_basis, NOW());
    UPDATE accounts SET current_balance = wallet.opening_balance + v_incoming - v_outgoing, updated_at = NOW()
      WHERE id = p_account_id;
  ELSE
    SELECT COALESCE(SUM(amount), 0) INTO v_incoming FROM transactions
      WHERE destination_account_id = p_account_id AND is_reversed = false;
    SELECT COALESCE(SUM(amount), 0) INTO v_outgoing FROM transactions
      WHERE source_account_id = p_account_id AND is_reversed = false;
    UPDATE accounts SET current_balance = v_incoming - v_outgoing, updated_at = NOW()
      WHERE id = p_account_id;
  END IF;
END;
$$ LANGUAGE plpgsql;
