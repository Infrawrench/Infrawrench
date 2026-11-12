ALTER TABLE "ci_runs" ADD COLUMN "concurrency" jsonb;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD COLUMN "cancel_requested_at" timestamp;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD COLUMN "cancel_sent_at" timestamp;--> statement-breakpoint
CREATE INDEX "ci_runs_repo_status_idx" ON "ci_runs" USING btree ("installation_id","repo_full_name","status");