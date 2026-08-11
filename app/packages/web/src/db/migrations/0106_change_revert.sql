ALTER TABLE "resource_changes" ADD COLUMN "reverted_at" timestamp;--> statement-breakpoint
ALTER TABLE "resource_changes" ADD COLUMN "reverted_by_user_id" text;--> statement-breakpoint
ALTER TABLE "resource_changes" ADD COLUMN "revert_claimed_at" timestamp;
