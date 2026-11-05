-- Manual migration: learned statement-description links for fixed charges.
-- Additive and idempotent. Apply after a successful backup.

CREATE TABLE IF NOT EXISTS "fatura_match_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "card_account_id" uuid NOT NULL,
  "raw_normalized" varchar(300) NOT NULL,
  "target_schedule_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "fatura_match_rules_user_card_raw_unique"
    UNIQUE("user_id", "card_account_id", "raw_normalized"),
  CONSTRAINT "fatura_match_rules_user_id_user_profiles_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."user_profiles"("id") ON DELETE cascade,
  CONSTRAINT "fatura_match_rules_card_account_id_accounts_id_fk"
    FOREIGN KEY ("card_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade,
  CONSTRAINT "fatura_match_rules_target_schedule_id_scheduled_transactions_id_fk"
    FOREIGN KEY ("target_schedule_id") REFERENCES "public"."scheduled_transactions"("id")
      ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS "fatura_match_rules_user_card_idx"
  ON "fatura_match_rules" ("user_id", "card_account_id");

CREATE INDEX IF NOT EXISTS "fatura_match_rules_schedule_idx"
  ON "fatura_match_rules" ("target_schedule_id");

ALTER TABLE fatura_match_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE fatura_match_rules FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fatura_match_rules_user_isolation ON fatura_match_rules;
CREATE POLICY fatura_match_rules_user_isolation ON fatura_match_rules
  USING (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

DROP TRIGGER IF EXISTS trg_updated_at_fatura_match_rules ON fatura_match_rules;
CREATE TRIGGER trg_updated_at_fatura_match_rules
  BEFORE UPDATE ON fatura_match_rules
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON fatura_match_rules TO app_user;
