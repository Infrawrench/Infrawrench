ALTER TABLE "agent_sessions" ADD COLUMN "surface" text DEFAULT 'terminal' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_settings" ADD COLUMN "surface" text DEFAULT 'terminal' NOT NULL;