ALTER TABLE "ci_runs" ADD COLUMN "retry_of_run_id" text;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD COLUMN "no_task_cache" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD CONSTRAINT "ci_runs_retry_of_run_id_ci_runs_id_fk" FOREIGN KEY ("retry_of_run_id") REFERENCES "public"."ci_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ci_runs_retry_of_idx" ON "ci_runs" USING btree ("retry_of_run_id");