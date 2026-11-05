ALTER TABLE "scheduled_transactions" DROP CONSTRAINT "scheduled_transactions_source_account_id_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "scheduled_transactions" DROP CONSTRAINT "scheduled_transactions_destination_account_id_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_source_account_id_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_destination_account_id_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_paid_from_account_id_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "manual_balance_date" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TYPE "public"."income_frequency" ADD VALUE IF NOT EXISTS 'once';--> statement-breakpoint
UPDATE "income_source_configs" SET "frequency" = 'once' WHERE "frequency" = 'one_time';--> statement-breakpoint
ALTER TABLE "income_source_configs" ALTER COLUMN "frequency" SET DATA TYPE frequency USING frequency::text::frequency;--> statement-breakpoint
ALTER TABLE "month_closings" ADD COLUMN "updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scheduled_transactions" ADD CONSTRAINT "scheduled_transactions_source_account_id_accounts_id_fk" FOREIGN KEY ("source_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_transactions" ADD CONSTRAINT "scheduled_transactions_destination_account_id_accounts_id_fk" FOREIGN KEY ("destination_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_source_account_id_accounts_id_fk" FOREIGN KEY ("source_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_destination_account_id_accounts_id_fk" FOREIGN KEY ("destination_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_paid_from_account_id_accounts_id_fk" FOREIGN KEY ("paid_from_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_shares_shared_with_idx" ON "account_shares" USING btree ("shared_with_user_id");--> statement-breakpoint
CREATE INDEX "month_closings_user_id_idx" ON "month_closings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "credit_card_configs" ADD CONSTRAINT "credit_card_configs_closing_day_check" CHECK ("credit_card_configs"."closing_day" BETWEEN 1 AND 31);--> statement-breakpoint
ALTER TABLE "credit_card_configs" ADD CONSTRAINT "credit_card_configs_due_day_check" CHECK ("credit_card_configs"."due_day" BETWEEN 1 AND 31);--> statement-breakpoint
ALTER TABLE "loan_configs" ADD CONSTRAINT "loan_configs_total_installments_check" CHECK ("loan_configs"."total_installments" > 0);--> statement-breakpoint
ALTER TABLE "loan_configs" ADD CONSTRAINT "loan_configs_due_day_check" CHECK ("loan_configs"."due_day" BETWEEN 1 AND 31);--> statement-breakpoint
ALTER TABLE "month_closings" ADD CONSTRAINT "month_closings_month_check" CHECK ("month_closings"."month" BETWEEN 1 AND 12);--> statement-breakpoint
ALTER TABLE "month_closings" ADD CONSTRAINT "month_closings_year_check" CHECK ("month_closings"."year" > 0);--> statement-breakpoint
ALTER TABLE "scheduled_transactions" ADD CONSTRAINT "scheduled_transactions_amount_check" CHECK ("scheduled_transactions"."amount" > 0);--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_amount_check" CHECK ("transactions"."amount" > 0);--> statement-breakpoint
DROP TYPE "public"."income_frequency";