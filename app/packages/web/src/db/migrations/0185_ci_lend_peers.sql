ALTER TABLE "resources" ADD COLUMN "incarnation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ci_cloud_jobs" ADD COLUMN "peer_resource_id" text;--> statement-breakpoint
ALTER TABLE "ci_resource_grants" ADD COLUMN "resource_incarnation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ci_resource_grants" ADD COLUMN "peer_plugin_id" text;--> statement-breakpoint
ALTER TABLE "ci_resource_grants" ADD COLUMN "peer_lend_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ci_resource_grants" ADD COLUMN "peer_job_kinds" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ci_resource_grants" ADD COLUMN "peer_max_concurrent_jobs" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "ci_resource_grants" ADD COLUMN "peer_max_job_minutes" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "ci_resource_grants" ADD COLUMN "peer_job_regions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ci_resource_grants" ADD COLUMN "peer_preflight" jsonb DEFAULT '{}'::jsonb NOT NULL;