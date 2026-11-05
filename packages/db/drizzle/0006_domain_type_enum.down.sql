-- Reverse of 0006_domain_type_enum.sql.
-- Converts domain_type columns back to varchar(50) and drops the enum.
-- Only invoke if the forward migration needs to be rolled back; the
-- database backup taken by scripts/db-safe-migrate.sh is the preferred
-- recovery path for production.

DROP INDEX IF EXISTS "tx_bill_payment_unique";--> statement-breakpoint

ALTER TABLE "transactions"
  ALTER COLUMN "domain_type" TYPE varchar(50)
  USING "domain_type"::text;--> statement-breakpoint

ALTER TABLE "scheduled_transactions"
  ALTER COLUMN "domain_type" TYPE varchar(50)
  USING "domain_type"::text;--> statement-breakpoint

DROP TYPE "public"."domain_type";--> statement-breakpoint

CREATE UNIQUE INDEX "tx_bill_payment_unique"
  ON "transactions" ("destination_account_id", "billing_month", "billing_year")
  WHERE domain_type = 'bill_payment' AND is_reversed = false;
