CREATE TYPE "public"."account_type" AS ENUM('checking', 'savings', 'investment', 'credit_card', 'loan', 'personal_debt', 'expense', 'revenue', 'family_loan');--> statement-breakpoint
CREATE TYPE "public"."card_group" AS ENUM('credit_card', 'store_card', 'grocery', 'marketplace_loan', 'vehicle');--> statement-breakpoint
CREATE TYPE "public"."category_type" AS ENUM('expense', 'revenue', 'transfer');--> statement-breakpoint
CREATE TYPE "public"."frequency" AS ENUM('once', 'weekly', 'biweekly', 'monthly', 'bimonthly', 'quarterly', 'semiannual', 'annual');--> statement-breakpoint
CREATE TYPE "public"."income_category" AS ENUM('salary_clt', 'salary_pj', 'contractor', 'rental', 'investment', 'freelance', 'business', 'other');--> statement-breakpoint
CREATE TYPE "public"."income_frequency" AS ENUM('monthly', 'biweekly', 'weekly', 'annual', 'one_time');--> statement-breakpoint
CREATE TYPE "public"."loan_category" AS ENUM('bank', 'personal');--> statement-breakpoint
CREATE TYPE "public"."loan_type" AS ENUM('consignado', 'pessoal', 'veiculo', 'imobiliario');--> statement-breakpoint
CREATE TYPE "public"."month_status" AS ENUM('open', 'review', 'closed');--> statement-breakpoint
CREATE TYPE "public"."payoff_calculation_type" AS ENUM('consignado_mensal', 'pessoal_diario', 'cdc_veiculos', 'sem_desconto');--> statement-breakpoint
CREATE TYPE "public"."share_permission" AS ENUM('view', 'edit');--> statement-breakpoint
CREATE TYPE "public"."transaction_type" AS ENUM('withdrawal', 'deposit', 'transfer');--> statement-breakpoint
CREATE TABLE "account_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"shared_with_user_id" uuid NOT NULL,
	"permission" "share_permission" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_shares_unique" UNIQUE("account_id","shared_with_user_id")
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"type" "account_type" NOT NULL,
	"currency" varchar(3) DEFAULT 'BRL' NOT NULL,
	"current_balance" numeric(12, 2) DEFAULT '0' NOT NULL,
	"icon" varchar(50),
	"color" varchar(20),
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"overdraft_limit" numeric(12, 2),
	"cdi_percentage" numeric(6, 2),
	"manual_balance" numeric(12, 2),
	"manual_balance_date" timestamp,
	"parent_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"type" "category_type" NOT NULL,
	"parent_id" uuid,
	"icon" varchar(50),
	"color" varchar(20),
	"is_system" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_unique_name" UNIQUE("user_id","name")
);
--> statement-breakpoint
CREATE TABLE "credit_card_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"closing_day" integer NOT NULL,
	"due_day" integer NOT NULL,
	"credit_limit" numeric(12, 2),
	"bill_parser_type" varchar(50),
	"is_due_day_variable" boolean DEFAULT false NOT NULL,
	"card_group" "card_group" DEFAULT 'credit_card' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_card_configs_account_id_unique" UNIQUE("account_id")
);
--> statement-breakpoint
CREATE TABLE "borrowed_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_loan_config_id" uuid NOT NULL,
	"credit_card_account_id" uuid NOT NULL,
	"description" varchar(200),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "family_loan_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"person_name" varchar(200) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "family_loan_configs_account_id_unique" UNIQUE("account_id")
);
--> statement-breakpoint
CREATE TABLE "income_source_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"frequency" "income_frequency" NOT NULL,
	"category" "income_category" NOT NULL,
	"payment_day" integer,
	"exchange_rate" numeric(10, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "income_source_configs_account_id_unique" UNIQUE("account_id")
);
--> statement-breakpoint
CREATE TABLE "loan_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"loan_category" "loan_category" NOT NULL,
	"loan_type" "loan_type",
	"total_installments" integer NOT NULL,
	"current_installment" integer,
	"monthly_payment" numeric(12, 2) NOT NULL,
	"due_day" integer NOT NULL,
	"monthly_interest_rate" numeric(10, 8),
	"annual_interest_rate" numeric(10, 8),
	"insurance_amount" numeric(12, 2),
	"insurance_payment_day" integer,
	"payoff_calculation_type" "payoff_calculation_type",
	"principal_amount" numeric(12, 2),
	"original_amount" numeric(12, 2),
	"start_date" date,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loan_configs_account_id_unique" UNIQUE("account_id")
);
--> statement-breakpoint
CREATE TABLE "month_closings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"month" integer NOT NULL,
	"year" integer NOT NULL,
	"status" "month_status" DEFAULT 'open' NOT NULL,
	"total_income" numeric(12, 2),
	"total_expenses" numeric(12, 2),
	"total_balance" numeric(12, 2),
	"detailed_breakdown" jsonb,
	"closed_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "month_closings_unique" UNIQUE("user_id","month","year")
);
--> statement-breakpoint
CREATE TABLE "scheduled_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_account_id" uuid NOT NULL,
	"destination_account_id" uuid NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"currency" varchar(3) DEFAULT 'BRL' NOT NULL,
	"description" varchar(500) NOT NULL,
	"category_id" uuid,
	"frequency" "frequency" NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"due_day" integer,
	"total_occurrences" integer,
	"starting_occurrence" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"domain_type" varchar(50),
	"domain_config_id" uuid,
	"is_fixed_charge" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_account_id" uuid NOT NULL,
	"destination_account_id" uuid NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"currency" varchar(3) DEFAULT 'BRL' NOT NULL,
	"type" "transaction_type" NOT NULL,
	"description" varchar(500) NOT NULL,
	"date" date NOT NULL,
	"notes" text,
	"category_id" uuid,
	"billing_month" integer,
	"billing_year" integer,
	"installment_number" integer,
	"total_installments" integer,
	"is_paid" boolean DEFAULT false NOT NULL,
	"paid_at" timestamp with time zone,
	"paid_from_account_id" uuid,
	"is_reversed" boolean DEFAULT false NOT NULL,
	"reversed_at" timestamp with time zone,
	"reversed_by_transaction_id" uuid,
	"reverses_transaction_id" uuid,
	"scheduled_transaction_id" uuid,
	"domain_type" varchar(50),
	"exchange_rate" numeric(10, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"name" varchar(200) NOT NULL,
	"password_hash" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "account_shares" ADD CONSTRAINT "account_shares_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_shares" ADD CONSTRAINT "account_shares_shared_with_user_id_users_id_fk" FOREIGN KEY ("shared_with_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_parent_account_id_accounts_id_fk" FOREIGN KEY ("parent_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_card_configs" ADD CONSTRAINT "credit_card_configs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "borrowed_cards" ADD CONSTRAINT "borrowed_cards_family_loan_config_id_family_loan_configs_id_fk" FOREIGN KEY ("family_loan_config_id") REFERENCES "public"."family_loan_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "borrowed_cards" ADD CONSTRAINT "borrowed_cards_credit_card_account_id_accounts_id_fk" FOREIGN KEY ("credit_card_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_loan_configs" ADD CONSTRAINT "family_loan_configs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_source_configs" ADD CONSTRAINT "income_source_configs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_configs" ADD CONSTRAINT "loan_configs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "month_closings" ADD CONSTRAINT "month_closings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_transactions" ADD CONSTRAINT "scheduled_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_transactions" ADD CONSTRAINT "scheduled_transactions_source_account_id_accounts_id_fk" FOREIGN KEY ("source_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_transactions" ADD CONSTRAINT "scheduled_transactions_destination_account_id_accounts_id_fk" FOREIGN KEY ("destination_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_transactions" ADD CONSTRAINT "scheduled_transactions_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_source_account_id_accounts_id_fk" FOREIGN KEY ("source_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_destination_account_id_accounts_id_fk" FOREIGN KEY ("destination_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_paid_from_account_id_accounts_id_fk" FOREIGN KEY ("paid_from_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_reversed_by_transaction_id_transactions_id_fk" FOREIGN KEY ("reversed_by_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_reverses_transaction_id_transactions_id_fk" FOREIGN KEY ("reverses_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_scheduled_transaction_id_scheduled_transactions_id_fk" FOREIGN KEY ("scheduled_transaction_id") REFERENCES "public"."scheduled_transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "accounts_user_active_idx" ON "accounts" USING btree ("user_id","is_active");--> statement-breakpoint
CREATE INDEX "accounts_user_type_idx" ON "accounts" USING btree ("user_id","type");--> statement-breakpoint
CREATE INDEX "accounts_parent_idx" ON "accounts" USING btree ("parent_account_id");--> statement-breakpoint
CREATE INDEX "categories_user_idx" ON "categories" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "bc_config_idx" ON "borrowed_cards" USING btree ("family_loan_config_id");--> statement-breakpoint
CREATE INDEX "bc_card_idx" ON "borrowed_cards" USING btree ("credit_card_account_id");--> statement-breakpoint
CREATE INDEX "st_user_idx" ON "scheduled_transactions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "st_user_active_idx" ON "scheduled_transactions" USING btree ("user_id","is_active");--> statement-breakpoint
CREATE INDEX "st_domain_idx" ON "scheduled_transactions" USING btree ("domain_type","domain_config_id");--> statement-breakpoint
CREATE INDEX "st_source_idx" ON "scheduled_transactions" USING btree ("source_account_id");--> statement-breakpoint
CREATE INDEX "st_dest_idx" ON "scheduled_transactions" USING btree ("destination_account_id");--> statement-breakpoint
CREATE INDEX "tx_user_date_idx" ON "transactions" USING btree ("user_id","date");--> statement-breakpoint
CREATE INDEX "tx_source_idx" ON "transactions" USING btree ("source_account_id","date");--> statement-breakpoint
CREATE INDEX "tx_dest_idx" ON "transactions" USING btree ("destination_account_id","date");--> statement-breakpoint
CREATE INDEX "tx_billing_idx" ON "transactions" USING btree ("destination_account_id","billing_month","billing_year");--> statement-breakpoint
CREATE INDEX "tx_user_paid_idx" ON "transactions" USING btree ("user_id","is_paid","date");--> statement-breakpoint
CREATE INDEX "tx_scheduled_idx" ON "transactions" USING btree ("scheduled_transaction_id");--> statement-breakpoint
CREATE INDEX "tx_domain_type_idx" ON "transactions" USING btree ("domain_type","user_id");--> statement-breakpoint
CREATE INDEX "tx_user_billing_idx" ON "transactions" USING btree ("user_id","billing_month","billing_year");