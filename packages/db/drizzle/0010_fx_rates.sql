-- Manual migration: add the global fx_rates table (daily USD->BRL cache).
-- Applied: 2026-06-03
--
-- Continues the hand-written migration chain (0005_audit_hardening ..
-- 0009_domain_type_refund_check) — these live outside drizzle-kit's _journal.json
-- (which tracks only the generated 0000-0004) and are applied manually / via
-- db-safe-migrate. Numbered 0010 to avoid the 0005 collision drizzle-kit generate
-- produces (it only sees the journal up to 0004).
--
-- Purpose: FxRateService.refreshIfStale() caches one fetched rate per (base,quote)
-- per calendar day (fetched_on gate) and syncs income_source_configs.exchange_rate
-- for USD income sources. Global reference data: no user_id, no RLS.
--
-- Additive only (CREATE TABLE) — no data risk. Already applied to the dev DB on
-- 2026-06-03 (the dev DB is not __drizzle_migrations-tracked); recreated here for
-- the migration record. Mirror in packages/db/src/schema/fx-rates.ts (used by
-- drizzle-kit push for the test DB).

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
