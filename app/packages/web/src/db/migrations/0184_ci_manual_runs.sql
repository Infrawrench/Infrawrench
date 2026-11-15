ALTER TABLE "ci_runs" ADD COLUMN "inputs" jsonb;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD COLUMN "started_by_user_id" text;--> statement-breakpoint
ALTER TABLE "ci_schedules" ADD COLUMN "manual" jsonb;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD CONSTRAINT "ci_runs_started_by_user_id_users_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;