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
