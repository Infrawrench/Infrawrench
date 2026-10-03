ALTER TABLE "workflows" ADD COLUMN "source_author_user_id" text;--> statement-breakpoint
-- Until now automated runs acted for the creator, so existing workflows keep
-- running as exactly who they ran as before; the next edit re-attributes.
UPDATE "workflows" SET "source_author_user_id" = "created_by_user_id";
