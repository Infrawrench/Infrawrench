DROP INDEX "git_commit_emails_verified_idx";--> statement-breakpoint
ALTER TABLE "git_commit_emails" ADD COLUMN "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "git_commit_emails_active_idx" ON "git_commit_emails" USING btree ("organization_id","email") WHERE "git_commit_emails"."active";