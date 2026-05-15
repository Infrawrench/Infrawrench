ALTER TABLE "accounts" DROP COLUMN "latest_stats_json";--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "stats_fetched_at";--> statement-breakpoint
ALTER TABLE "resources" DROP COLUMN "latest_stats_json";--> statement-breakpoint
ALTER TABLE "resources" DROP COLUMN "latest_metrics_json";--> statement-breakpoint
ALTER TABLE "resources" DROP COLUMN "stats_fetched_at";