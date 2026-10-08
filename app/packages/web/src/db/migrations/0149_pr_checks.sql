CREATE TABLE "pr_check_repositories" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"installation_id" integer NOT NULL,
	"repo" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"comment_enabled" boolean DEFAULT false NOT NULL,
	"cost_threshold" double precision,
	"threshold_conclusion" text DEFAULT 'neutral' NOT NULL,
	"directories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pr_check_repositories_threshold_conclusion_valid" CHECK ("pr_check_repositories"."threshold_conclusion" IN ('neutral', 'failure'))
);
--> statement-breakpoint
CREATE TABLE "pr_check_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"pull_number" integer NOT NULL,
	"pull_title" text,
	"pull_url" text,
	"head_sha" text NOT NULL,
	"base_sha" text,
	"status" text DEFAULT 'running' NOT NULL,
	"conclusion" text,
	"check_run_id" bigint,
	"check_run_url" text,
	"comment_id" bigint,
	"comment_url" text,
	"report" jsonb,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	CONSTRAINT "pr_check_runs_status_valid" CHECK ("pr_check_runs"."status" IN ('running', 'completed', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "pr_check_repositories" ADD CONSTRAINT "pr_check_repositories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_check_runs" ADD CONSTRAINT "pr_check_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_check_runs" ADD CONSTRAINT "pr_check_runs_repository_id_pr_check_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."pr_check_repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pr_check_repositories_org_repo_idx" ON "pr_check_repositories" USING btree ("organization_id","repo");--> statement-breakpoint
CREATE UNIQUE INDEX "pr_check_runs_claim_idx" ON "pr_check_runs" USING btree ("repository_id","pull_number","head_sha");--> statement-breakpoint
CREATE INDEX "pr_check_runs_org_created_idx" ON "pr_check_runs" USING btree ("organization_id","created_at");