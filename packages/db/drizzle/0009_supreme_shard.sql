-- Additive S02 delta. Generated CREATE TABLE/FK/index statements for fatura_imports
-- and fatura_match_rules were removed: manual migrations 0021/0024 already own them.
-- Apply only after the complete manual history in MIGRATION-ORDER.md.
ALTER TABLE "fatura_imports" ADD COLUMN "closing_date" date;--> statement-breakpoint
ALTER TABLE "fatura_imports" ADD COLUMN "closing_date_source" varchar(20) DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "fatura_imports" ADD COLUMN "due_date_source" varchar(20) DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "fatura_imports" ADD COLUMN "period_confidence" varchar(20) DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "fatura_imports" ADD COLUMN "document_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "credit_card_bills" ADD COLUMN "closing_date" date;
--> statement-breakpoint
ALTER TABLE "credit_card_bills" ADD COLUMN "due_date" date;
--> statement-breakpoint
ALTER TABLE "credit_card_bills" ADD COLUMN "closing_date_source" varchar(20) DEFAULT 'unknown' NOT NULL;
--> statement-breakpoint
ALTER TABLE "credit_card_bills" ADD COLUMN "due_date_source" varchar(20) DEFAULT 'unknown' NOT NULL;
--> statement-breakpoint
ALTER TABLE "scheduled_transactions" ADD COLUMN "amount_changes" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "scheduled_transactions" ADD COLUMN "purchase_date" date;
--> statement-breakpoint
ALTER TABLE "scheduled_transactions" ADD COLUMN "purchase_date_source" varchar(20) DEFAULT 'unknown' NOT NULL;
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "purchase_date" date;
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "posted_date" date;
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "purchase_date_source" varchar(20) DEFAULT 'unknown' NOT NULL;
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "posted_date_source" varchar(20) DEFAULT 'unknown' NOT NULL;
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "is_amount_overridden" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "fatura_imports_document_unique" ON "fatura_imports" USING btree ("user_id","card_account_id","document_hash") WHERE "fatura_imports"."document_hash" IS NOT NULL AND "fatura_imports"."status" != 'discarded';
--> statement-breakpoint
ALTER TABLE "credit_card_bills" ADD CONSTRAINT "ccb_date_order" CHECK ("credit_card_bills"."closing_date" IS NULL OR "credit_card_bills"."due_date" IS NULL OR "credit_card_bills"."due_date" >= "credit_card_bills"."closing_date");
--> statement-breakpoint
ALTER TABLE "credit_card_bills" ADD CONSTRAINT "ccb_closing_period" CHECK ("credit_card_bills"."closing_date" IS NULL OR (EXTRACT(MONTH FROM "credit_card_bills"."closing_date") = "credit_card_bills"."month" AND EXTRACT(YEAR FROM "credit_card_bills"."closing_date") = "credit_card_bills"."year"));
--> statement-breakpoint
ALTER TABLE "credit_card_bills" ADD CONSTRAINT "ccb_date_sources" CHECK ("credit_card_bills"."closing_date_source" IN ('institution','user','configuration','unknown') AND "credit_card_bills"."due_date_source" IN ('institution','user','configuration','unknown'));
--> statement-breakpoint
ALTER TABLE "scheduled_transactions" ADD CONSTRAINT "sched_purchase_date_source" CHECK ("scheduled_transactions"."purchase_date_source" IN ('institution','user','configuration','unknown'));
--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "tx_statement_date_sources" CHECK ("transactions"."purchase_date_source" IN ('institution','user','configuration','unknown') AND "transactions"."posted_date_source" IN ('institution','user','configuration','unknown'));
