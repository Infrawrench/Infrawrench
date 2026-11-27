CREATE TABLE "ci_git_repositories" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"git_repository_id" text NOT NULL,
	"namespace" text NOT NULL,
	"name" text NOT NULL,
	"default_branch" text NOT NULL,
	"ci_enabled" boolean DEFAULT true NOT NULL,
	"changed_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ci_runs" ADD COLUMN "git_repository_id" text;--> statement-breakpoint
ALTER TABLE "ci_schedules" ADD COLUMN "git_repository_id" text;--> statement-breakpoint
ALTER TABLE "ci_git_repositories" ADD CONSTRAINT "ci_git_repositories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_git_repositories" ADD CONSTRAINT "ci_git_repositories_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ci_git_repositories_repo_idx" ON "ci_git_repositories" USING btree ("git_repository_id");--> statement-breakpoint
CREATE INDEX "ci_git_repositories_org_idx" ON "ci_git_repositories" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ci_runs_git_repo_idx" ON "ci_runs" USING btree ("git_repository_id","status");