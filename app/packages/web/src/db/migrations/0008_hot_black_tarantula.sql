ALTER TABLE "accounts" ADD COLUMN "latest_stats_json" jsonb;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "stats_fetched_at" timestamp;--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN "latest_stats_json" jsonb;--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN "latest_metrics_json" jsonb;--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN "stats_fetched_at" timestamp;