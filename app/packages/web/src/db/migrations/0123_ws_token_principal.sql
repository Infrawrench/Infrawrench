ALTER TABLE "ws_tokens" ADD COLUMN "scopes" jsonb;--> statement-breakpoint
ALTER TABLE "ws_tokens" ADD COLUMN "agent_registration_id" text;