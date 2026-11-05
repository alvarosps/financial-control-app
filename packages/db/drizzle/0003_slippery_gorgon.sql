CREATE TABLE "materialization_status" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"last_materialized_at" timestamp with time zone DEFAULT now() NOT NULL,
	"horizon_end" date NOT NULL,
	"schedules_hash" varchar(100) NOT NULL,
	CONSTRAINT "materialization_status_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "materialization_status" ADD CONSTRAINT "materialization_status_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mat_status_user_idx" ON "materialization_status" USING btree ("user_id");