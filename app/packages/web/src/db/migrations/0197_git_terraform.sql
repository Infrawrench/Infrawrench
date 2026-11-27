CREATE TABLE "git_terraform_managed_resources" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"state_version_id" text,
	"address" text NOT NULL,
	"terraform_type" text NOT NULL,
	"provider" text,
	"label" text,
	"resource_id" text,
	"matched_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_terraform_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"kind" text NOT NULL,
	"trigger" text NOT NULL,
	"commit_sha" text NOT NULL,
	"branch" text,
	"pull_number" integer,
	"status" text DEFAULT 'queued' NOT NULL,
	"plan_summary" jsonb,
	"resources_to_add" integer,
	"resources_to_change" integer,
	"resources_to_destroy" integer,
	"cost_delta" jsonb,
	"ci_run_id" text,
	"started_by_user_id" text,
	"approved_by_user_id" text,
	"approved_at" timestamp,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"finished_at" timestamp,
	CONSTRAINT "git_terraform_runs_kind_valid" CHECK ("git_terraform_runs"."kind" IN ('plan', 'apply')),
	CONSTRAINT "git_terraform_runs_status_valid" CHECK ("git_terraform_runs"."status" IN ('queued', 'running', 'planned', 'awaiting_approval', 'applied', 'failed', 'cancelled', 'superseded'))
);
--> statement-breakpoint
CREATE TABLE "git_terraform_state_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"serial" integer NOT NULL,
	"lineage" text NOT NULL,
	"r2_key" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"terraform_version" text,
	"resource_count" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_by_user_id" text,
	"run_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_terraform_workspace_accounts" (
	"workspace_id" text NOT NULL,
	"account_id" text NOT NULL,
	"added_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "git_terraform_workspace_accounts_workspace_id_account_id_pk" PRIMARY KEY("workspace_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "git_terraform_workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"repository_id" text NOT NULL,
	"organization_id" text,
	"name" text NOT NULL,
	"root_path" text DEFAULT '' NOT NULL,
	"auto_apply" boolean DEFAULT false NOT NULL,
	"product" text DEFAULT 'terraform' NOT NULL,
	"tool_version" text,
	"variables" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_variables" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"lock_id" text,
	"lock_info" jsonb,
	"locked_by" text,
	"locked_at" timestamp,
	"current_state_version_id" text,
	"current_serial" integer,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "git_terraform_workspaces_product_valid" CHECK ("git_terraform_workspaces"."product" IN ('terraform', 'opentofu'))
);
--> statement-breakpoint
ALTER TABLE "git_terraform_managed_resources" ADD CONSTRAINT "git_terraform_managed_resources_workspace_id_git_terraform_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."git_terraform_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_terraform_managed_resources" ADD CONSTRAINT "git_terraform_managed_resources_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_terraform_managed_resources" ADD CONSTRAINT "git_terraform_managed_resources_state_version_id_git_terraform_state_versions_id_fk" FOREIGN KEY ("state_version_id") REFERENCES "public"."git_terraform_state_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_terraform_runs" ADD CONSTRAINT "git_terraform_runs_workspace_id_git_terraform_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."git_terraform_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_terraform_runs" ADD CONSTRAINT "git_terraform_runs_started_by_user_id_users_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_terraform_runs" ADD CONSTRAINT "git_terraform_runs_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_terraform_state_versions" ADD CONSTRAINT "git_terraform_state_versions_workspace_id_git_terraform_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."git_terraform_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_terraform_state_versions" ADD CONSTRAINT "git_terraform_state_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_terraform_state_versions" ADD CONSTRAINT "git_terraform_state_versions_run_id_git_terraform_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."git_terraform_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_terraform_workspace_accounts" ADD CONSTRAINT "git_terraform_workspace_accounts_workspace_id_git_terraform_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."git_terraform_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_terraform_workspace_accounts" ADD CONSTRAINT "git_terraform_workspace_accounts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_terraform_workspace_accounts" ADD CONSTRAINT "git_terraform_workspace_accounts_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_terraform_workspaces" ADD CONSTRAINT "git_terraform_workspaces_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_terraform_workspaces" ADD CONSTRAINT "git_terraform_workspaces_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "git_terraform_managed_resources_workspace_address_idx" ON "git_terraform_managed_resources" USING btree ("workspace_id","address");--> statement-breakpoint
CREATE INDEX "git_terraform_managed_resources_org_resource_idx" ON "git_terraform_managed_resources" USING btree ("organization_id","resource_id");--> statement-breakpoint
CREATE INDEX "git_terraform_runs_workspace_created_idx" ON "git_terraform_runs" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "git_terraform_runs_repo_pull_idx" ON "git_terraform_runs" USING btree ("repository_id","pull_number");--> statement-breakpoint
CREATE INDEX "git_terraform_runs_ci_run_idx" ON "git_terraform_runs" USING btree ("ci_run_id");--> statement-breakpoint
CREATE INDEX "git_terraform_state_versions_workspace_created_idx" ON "git_terraform_state_versions" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "git_terraform_state_versions_lineage_serial_idx" ON "git_terraform_state_versions" USING btree ("workspace_id","lineage","serial");--> statement-breakpoint
CREATE INDEX "git_terraform_workspace_accounts_account_idx" ON "git_terraform_workspace_accounts" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "git_terraform_workspaces_repo_name_idx" ON "git_terraform_workspaces" USING btree ("repository_id","name");--> statement-breakpoint
CREATE INDEX "git_terraform_workspaces_org_idx" ON "git_terraform_workspaces" USING btree ("organization_id");