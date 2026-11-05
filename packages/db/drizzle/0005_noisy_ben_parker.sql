CREATE TABLE IF NOT EXISTS "fx_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"base_currency" varchar(3) NOT NULL,
	"quote_currency" varchar(3) NOT NULL,
	"rate" numeric(18, 6) NOT NULL,
	"fetched_on" date NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" varchar(60) NOT NULL,
	CONSTRAINT "fx_rates_base_quote_unique" UNIQUE("base_currency","quote_currency")
);
--> statement-breakpoint
ALTER TABLE "income_source_configs" ADD COLUMN "biweekly_anchor" date;