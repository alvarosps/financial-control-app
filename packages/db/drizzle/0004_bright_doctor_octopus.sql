DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type type
    JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
    WHERE type.typname = 'domain_type' AND namespace.nspname = 'public'
  ) THEN
    CREATE TYPE "public"."domain_type" AS ENUM('credit_card_installment', 'credit_card_fixed_charge', 'credit_card_expense', 'credit_card_annual_fee', 'credit_card_refund', 'bill_payment', 'loan_payment', 'loan_insurance', 'family_loan_installment', 'family_loan_fixed_charge', 'family_loan_expense', 'family_loan_discount', 'recurring_bill', 'income_clt', 'income_pj', 'income_freelancer', 'income_rental', 'income_family_loan', 'income_other');
  END IF;
END $$;--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"name" varchar(200) NOT NULL,
	"password_hash" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"auth_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_profiles_email_unique" UNIQUE("email"),
	CONSTRAINT "user_profiles_auth_user_id_unique" UNIQUE("auth_user_id")
);
--> statement-breakpoint
ALTER TABLE "sessions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "sessions" CASCADE;--> statement-breakpoint
DROP TABLE "users" CASCADE;--> statement-breakpoint
ALTER TABLE "loan_configs" DROP CONSTRAINT IF EXISTS "loan_configs_total_installments_check";--> statement-breakpoint
ALTER TABLE "loan_configs" DROP CONSTRAINT IF EXISTS "loan_configs_due_day_check";--> statement-breakpoint
ALTER TABLE "scheduled_transactions" DROP CONSTRAINT IF EXISTS "scheduled_transactions_amount_check";--> statement-breakpoint
ALTER TABLE "transactions" DROP CONSTRAINT IF EXISTS "transactions_amount_check";--> statement-breakpoint
ALTER TABLE "account_shares" DROP CONSTRAINT IF EXISTS "account_shares_shared_with_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "accounts" DROP CONSTRAINT IF EXISTS "accounts_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT IF EXISTS "audit_log_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "categories" DROP CONSTRAINT IF EXISTS "categories_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "materialization_status" DROP CONSTRAINT IF EXISTS "materialization_status_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "month_closings" DROP CONSTRAINT IF EXISTS "month_closings_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "scheduled_transactions" DROP CONSTRAINT IF EXISTS "scheduled_transactions_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "scheduled_transactions" DROP CONSTRAINT IF EXISTS "scheduled_transactions_source_account_id_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "scheduled_transactions" DROP CONSTRAINT IF EXISTS "scheduled_transactions_destination_account_id_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "simulation_scenarios" DROP CONSTRAINT IF EXISTS "simulation_scenarios_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "transactions" DROP CONSTRAINT IF EXISTS "transactions_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "transactions" DROP CONSTRAINT IF EXISTS "transactions_source_account_id_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "transactions" DROP CONSTRAINT IF EXISTS "transactions_destination_account_id_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "transactions" DROP CONSTRAINT IF EXISTS "transactions_paid_from_account_id_accounts_id_fk";
--> statement-breakpoint
DROP INDEX "account_shares_shared_with_idx";--> statement-breakpoint
DROP INDEX "mat_status_user_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "tx_bill_payment_unique";--> statement-breakpoint
ALTER TABLE "credit_card_bills" DROP CONSTRAINT IF EXISTS "ccb_paid_consistency";--> statement-breakpoint
ALTER TABLE "scheduled_transactions" DROP CONSTRAINT IF EXISTS "sched_amount_positive";--> statement-breakpoint
ALTER TABLE "scheduled_transactions" DROP CONSTRAINT IF EXISTS "sched_first_billing_both_or_none";--> statement-breakpoint
ALTER TABLE "scheduled_transactions" DROP CONSTRAINT IF EXISTS "sched_first_billing_month_valid";--> statement-breakpoint
ALTER TABLE "transactions" DROP CONSTRAINT IF EXISTS "tx_amount_positive";--> statement-breakpoint
ALTER TABLE "credit_card_bills" ALTER COLUMN "paid_amount" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "loan_configs" ALTER COLUMN "loan_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "loan_configs" ALTER COLUMN "monthly_interest_rate" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "month_closings" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "month_closings" ALTER COLUMN "updated_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_transactions" ALTER COLUMN "domain_type" SET DATA TYPE domain_type USING "domain_type"::text::domain_type;--> statement-breakpoint
ALTER TABLE "simulation_scenarios" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "simulation_scenarios" ALTER COLUMN "updated_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "domain_type" SET DATA TYPE domain_type USING "domain_type"::text::domain_type;--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "updated_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_card_bills" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_transactions" ADD COLUMN IF NOT EXISTS "first_billing_month" integer;--> statement-breakpoint
ALTER TABLE "scheduled_transactions" ADD COLUMN IF NOT EXISTS "first_billing_year" integer;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
ALTER TABLE "account_shares" ADD CONSTRAINT "account_shares_shared_with_user_id_user_profiles_id_fk" FOREIGN KEY ("shared_with_user_id") REFERENCES "public"."user_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_user_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_user_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_user_id_user_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "materialization_status" ADD CONSTRAINT "materialization_status_user_id_user_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "month_closings" ADD CONSTRAINT "month_closings_user_id_user_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_transactions" ADD CONSTRAINT "scheduled_transactions_user_id_user_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_transactions" ADD CONSTRAINT "scheduled_transactions_source_account_id_accounts_id_fk" FOREIGN KEY ("source_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_transactions" ADD CONSTRAINT "scheduled_transactions_destination_account_id_accounts_id_fk" FOREIGN KEY ("destination_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulation_scenarios" ADD CONSTRAINT "simulation_scenarios_user_id_user_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_user_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_source_account_id_accounts_id_fk" FOREIGN KEY ("source_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_destination_account_id_accounts_id_fk" FOREIGN KEY ("destination_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_paid_from_account_id_accounts_id_fk" FOREIGN KEY ("paid_from_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_user_created_idx" ON "audit_log" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "sim_scenarios_user_idx" ON "simulation_scenarios" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tx_bill_payment_unique" ON "transactions" USING btree ("destination_account_id","billing_month","billing_year") WHERE domain_type = 'bill_payment' AND is_reversed = false;--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "manual_balance";--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "manual_balance_date";--> statement-breakpoint
ALTER TABLE "loan_configs" DROP COLUMN "current_installment";--> statement-breakpoint
ALTER TABLE "borrowed_cards" ADD CONSTRAINT "bc_unique" UNIQUE("family_loan_config_id","credit_card_account_id");--> statement-breakpoint
ALTER TABLE "account_balance_snapshots" ADD CONSTRAINT "abs_month_check" CHECK ("account_balance_snapshots"."month" BETWEEN 1 AND 12);--> statement-breakpoint
ALTER TABLE "account_balance_snapshots" ADD CONSTRAINT "abs_year_check" CHECK ("account_balance_snapshots"."year" > 0);--> statement-breakpoint
ALTER TABLE "credit_card_bills" ADD CONSTRAINT "ccb_month_check" CHECK ("credit_card_bills"."month" BETWEEN 1 AND 12);--> statement-breakpoint
ALTER TABLE "credit_card_bills" ADD CONSTRAINT "ccb_year_check" CHECK ("credit_card_bills"."year" > 0);--> statement-breakpoint
ALTER TABLE "credit_card_bills" ADD CONSTRAINT "ccb_paid_consistency" CHECK (("credit_card_bills"."paid_at" IS NULL AND "credit_card_bills"."paid_amount" = 0) OR ("credit_card_bills"."paid_at" IS NOT NULL AND "credit_card_bills"."paid_amount" > 0));--> statement-breakpoint
ALTER TABLE "scheduled_transactions" ADD CONSTRAINT "sched_amount_positive" CHECK ("scheduled_transactions"."amount" > 0);--> statement-breakpoint
ALTER TABLE "scheduled_transactions" ADD CONSTRAINT "sched_first_billing_both_or_none" CHECK (("scheduled_transactions"."first_billing_month" IS NULL) = ("scheduled_transactions"."first_billing_year" IS NULL));--> statement-breakpoint
ALTER TABLE "scheduled_transactions" ADD CONSTRAINT "sched_first_billing_month_valid" CHECK ("scheduled_transactions"."first_billing_month" IS NULL OR "scheduled_transactions"."first_billing_month" BETWEEN 1 AND 12);--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "tx_amount_positive" CHECK ("transactions"."amount" > 0);
