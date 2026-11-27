CREATE TABLE "git_commit_emails" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"email" text NOT NULL,
	"verified_at" timestamp,
	"code_hash" text,
	"code_expires_at" timestamp,
	"code_attempts" integer DEFAULT 0 NOT NULL,
	"send_requested_at" timestamp,
	"sent_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "git_commit_emails" ADD CONSTRAINT "git_commit_emails_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_commit_emails" ADD CONSTRAINT "git_commit_emails_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "git_commit_emails_own_idx" ON "git_commit_emails" USING btree ("organization_id","user_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "git_commit_emails_verified_idx" ON "git_commit_emails" USING btree ("organization_id","email") WHERE "git_commit_emails"."verified_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "git_commit_emails_owed_idx" ON "git_commit_emails" USING btree ("send_requested_at") WHERE "git_commit_emails"."verified_at" IS NULL AND "git_commit_emails"."send_requested_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "git_commit_emails_user_idx" ON "git_commit_emails" USING btree ("user_id");