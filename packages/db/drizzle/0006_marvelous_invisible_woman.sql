ALTER TABLE "accounts" ADD COLUMN "opening_balance" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "opening_balance_anchor_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "is_default_wallet" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_default_wallet_unique" ON "accounts" USING btree ("user_id") WHERE is_default_wallet = true;