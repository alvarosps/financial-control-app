CREATE TABLE "budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"month" integer NOT NULL,
	"year" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'BRL' NOT NULL,
	"category_id" uuid,
	"economic_scope" varchar(12) DEFAULT 'all' NOT NULL,
	"limit_amount" numeric(12, 2) NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budgets_values" CHECK ("budgets"."month" BETWEEN 1 AND 12 AND "budgets"."year" BETWEEN 2000 AND 2200 AND "budgets"."currency" = 'BRL' AND "budgets"."limit_amount" > 0 AND "budgets"."version" > 0 AND "budgets"."economic_scope" IN ('all','own','family','work','property'))
);
--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_user_id_user_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "budgets_scope_unique" ON "budgets" USING btree ("user_id","year","month",coalesce("category_id", '00000000-0000-0000-0000-000000000000'::uuid),"economic_scope");
--> statement-breakpoint
ALTER TABLE budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE budgets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS budgets_owner ON budgets;
CREATE POLICY budgets_owner ON budgets FOR ALL USING (user_id = current_setting('app.current_user_id', true)::uuid) WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);
GRANT SELECT, INSERT ON budgets TO app_user;
GRANT UPDATE (limit_amount, version, updated_at) ON budgets TO app_user;
CREATE OR REPLACE FUNCTION validate_budget_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND ((to_jsonb(NEW) - ARRAY['limit_amount','version','updated_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['limit_amount','version','updated_at']) OR NEW.version <> OLD.version + 1) THEN
    RAISE EXCEPTION 'Budget scope is immutable and version must advance';
  END IF;
  IF NEW.category_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM categories WHERE id=NEW.category_id AND user_id=NEW.user_id AND type='expense') THEN
    RAISE EXCEPTION 'Budget category must belong to owner';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS budgets_validate ON budgets;
CREATE TRIGGER budgets_validate BEFORE INSERT OR UPDATE ON budgets FOR EACH ROW EXECUTE FUNCTION validate_budget_owner();
DROP TRIGGER IF EXISTS budgets_updated_at ON budgets;
CREATE TRIGGER budgets_updated_at BEFORE UPDATE ON budgets FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
