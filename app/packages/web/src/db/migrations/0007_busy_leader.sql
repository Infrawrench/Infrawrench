ALTER TABLE "accounts" ADD COLUMN "last_polled_at" timestamp;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "next_poll_at" timestamp;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "poll_failure_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "accounts_poll_due_idx" ON "accounts" USING btree ("next_poll_at");