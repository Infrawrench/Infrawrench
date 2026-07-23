ALTER TABLE "accounts" ADD COLUMN "cost_last_polled_at" timestamp;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "cost_next_poll_at" timestamp;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "cost_poll_failure_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "cost_backfilled_at" timestamp;--> statement-breakpoint
CREATE INDEX "accounts_cost_poll_due_idx" ON "accounts" USING btree ("cost_next_poll_at");