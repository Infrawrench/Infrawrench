ALTER TABLE "agent_sessions" ADD COLUMN "service_account_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "t3_access" text DEFAULT 't3-connect' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "service_installs_json" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_settings" ADD COLUMN "service_account_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_settings" ADD COLUMN "t3_access" text DEFAULT 't3-connect' NOT NULL;
