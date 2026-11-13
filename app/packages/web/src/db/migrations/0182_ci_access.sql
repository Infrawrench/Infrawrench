CREATE TABLE "ci_ssh_key_access" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"ssh_key_id" text NOT NULL,
	"ci_name" text NOT NULL,
	"repos" jsonb,
	"branch_pattern" text,
	"enabled_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ci_cloud_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"run_id" text NOT NULL,
	"proxy_run_id" text NOT NULL,
	"job_id" text NOT NULL,
	"job_name" text NOT NULL,
	"pipeline" text NOT NULL,
	"account_id" text,
	"plugin_id" text NOT NULL,
	"kind" text NOT NULL,
	"machine" text,
	"image" text,
	"region" text,
	"state" text NOT NULL,
	"outcome" text,
	"reason" text,
	"handle" jsonb,
	"callback_token_hash" text NOT NULL,
	"encrypted_claim" text,
	"claim_iv" text,
	"timeout_seconds" integer NOT NULL,
	"last_seen_at" timestamp,
	"claimed_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp,
	"claim_attempts" integer DEFAULT 0 NOT NULL,
	"teardown_attempts" integer DEFAULT 0 NOT NULL,
	"teardown_error" text,
	"next_attempt_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ci_connection_access" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"account_id" text NOT NULL,
	"jobs_enabled" boolean DEFAULT false NOT NULL,
	"job_kinds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_concurrent_jobs" integer DEFAULT 2 NOT NULL,
	"max_job_minutes" integer DEFAULT 60 NOT NULL,
	"job_repos" jsonb,
	"job_branch_pattern" text,
	"job_preflight" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"lend_enabled" boolean DEFAULT false NOT NULL,
	"lend_repos" jsonb,
	"lend_branch_pattern" text,
	"updated_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ci_resource_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"account_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"resource_type_id" text NOT NULL,
	"resource_name" text NOT NULL,
	"ci_name" text NOT NULL,
	"outputs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"secret_version" text,
	"repos" jsonb,
	"branch_pattern" text,
	"created_by_user_id" text,
	"updated_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ci_runs" ADD COLUMN "access" jsonb;--> statement-breakpoint
ALTER TABLE "ci_ssh_key_access" ADD CONSTRAINT "ci_ssh_key_access_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_ssh_key_access" ADD CONSTRAINT "ci_ssh_key_access_ssh_key_id_ssh_keys_id_fk" FOREIGN KEY ("ssh_key_id") REFERENCES "public"."ssh_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_ssh_key_access" ADD CONSTRAINT "ci_ssh_key_access_enabled_by_user_id_users_id_fk" FOREIGN KEY ("enabled_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_cloud_jobs" ADD CONSTRAINT "ci_cloud_jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_cloud_jobs" ADD CONSTRAINT "ci_cloud_jobs_run_id_ci_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ci_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_cloud_jobs" ADD CONSTRAINT "ci_cloud_jobs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_connection_access" ADD CONSTRAINT "ci_connection_access_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_connection_access" ADD CONSTRAINT "ci_connection_access_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_connection_access" ADD CONSTRAINT "ci_connection_access_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_resource_grants" ADD CONSTRAINT "ci_resource_grants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_resource_grants" ADD CONSTRAINT "ci_resource_grants_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_resource_grants" ADD CONSTRAINT "ci_resource_grants_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_resource_grants" ADD CONSTRAINT "ci_resource_grants_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ci_ssh_key_access_key_idx" ON "ci_ssh_key_access" USING btree ("ssh_key_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ci_ssh_key_access_org_name_idx" ON "ci_ssh_key_access" USING btree ("organization_id","ci_name");--> statement-breakpoint
CREATE UNIQUE INDEX "ci_cloud_jobs_run_job_idx" ON "ci_cloud_jobs" USING btree ("proxy_run_id","job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ci_cloud_jobs_token_idx" ON "ci_cloud_jobs" USING btree ("callback_token_hash");--> statement-breakpoint
CREATE INDEX "ci_cloud_jobs_state_idx" ON "ci_cloud_jobs" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "ci_cloud_jobs_account_idx" ON "ci_cloud_jobs" USING btree ("account_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "ci_connection_access_account_idx" ON "ci_connection_access" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "ci_connection_access_org_idx" ON "ci_connection_access" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ci_resource_grants_org_name_idx" ON "ci_resource_grants" USING btree ("organization_id","ci_name");--> statement-breakpoint
CREATE INDEX "ci_resource_grants_account_idx" ON "ci_resource_grants" USING btree ("account_id");