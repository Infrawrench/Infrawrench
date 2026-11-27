CREATE TABLE "git_issue_imports" (
	"id" text PRIMARY KEY NOT NULL,
	"repository_id" text NOT NULL,
	"source" text NOT NULL,
	"source_repository" text NOT NULL,
	"token_encrypted" text,
	"token_iv" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"phase" text DEFAULT 'labels' NOT NULL,
	"progress" jsonb NOT NULL,
	"error" text,
	"resume_at" timestamp,
	"started_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "git_push_mirrors" (
	"id" text PRIMARY KEY NOT NULL,
	"repository_id" text NOT NULL,
	"url" text NOT NULL,
	"username" text NOT NULL,
	"credential_encrypted" text NOT NULL,
	"credential_iv" text NOT NULL,
	"exclude" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"force" boolean DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"pending_generation" bigint DEFAULT 1 NOT NULL,
	"synced_generation" bigint DEFAULT 0 NOT NULL,
	"lease_token" text,
	"lease_until" timestamp,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp DEFAULT now() NOT NULL,
	"last_status" text,
	"last_error" text,
	"last_result" jsonb,
	"last_attempt_at" timestamp,
	"last_synced_at" timestamp,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "git_comments" ADD COLUMN "import_source" text;--> statement-breakpoint
ALTER TABLE "git_comments" ADD COLUMN "import_id" text;--> statement-breakpoint
ALTER TABLE "git_comments" ADD COLUMN "import_author" text;--> statement-breakpoint
ALTER TABLE "git_comments" ADD COLUMN "import_url" text;--> statement-breakpoint
ALTER TABLE "git_issues" ADD COLUMN "import_source" text;--> statement-breakpoint
ALTER TABLE "git_issues" ADD COLUMN "import_id" text;--> statement-breakpoint
ALTER TABLE "git_issues" ADD COLUMN "import_author" text;--> statement-breakpoint
ALTER TABLE "git_issues" ADD COLUMN "import_url" text;--> statement-breakpoint
ALTER TABLE "git_issues" ADD COLUMN "import_number" integer;--> statement-breakpoint
ALTER TABLE "git_issue_imports" ADD CONSTRAINT "git_issue_imports_repository_id_git_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."git_repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_issue_imports" ADD CONSTRAINT "git_issue_imports_started_by_user_id_users_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_push_mirrors" ADD CONSTRAINT "git_push_mirrors_repository_id_git_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."git_repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_push_mirrors" ADD CONSTRAINT "git_push_mirrors_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "git_issue_imports_repo_idx" ON "git_issue_imports" USING btree ("repository_id","created_at");--> statement-breakpoint
CREATE INDEX "git_issue_imports_status_idx" ON "git_issue_imports" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "git_push_mirrors_repo_url_idx" ON "git_push_mirrors" USING btree ("repository_id","url");--> statement-breakpoint
CREATE INDEX "git_push_mirrors_due_idx" ON "git_push_mirrors" USING btree ("enabled","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "git_comments_import_idx" ON "git_comments" USING btree ("repository_id","import_source","import_id") WHERE "git_comments"."import_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "git_issues_import_idx" ON "git_issues" USING btree ("repository_id","import_source","import_id") WHERE "git_issues"."import_id" IS NOT NULL;