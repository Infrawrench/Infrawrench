CREATE TABLE "organization_features" (
	"organization_id" text NOT NULL,
	"feature" text NOT NULL,
	"enabled_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "organization_features_organization_id_feature_pk" PRIMARY KEY("organization_id","feature")
);
--> statement-breakpoint
CREATE TABLE "ci_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"installation_id" integer NOT NULL,
	"account_login" text NOT NULL,
	"enabled_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ci_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"installation_id" integer NOT NULL,
	"repo_full_name" text NOT NULL,
	"owner_key" text NOT NULL,
	"repo_key" text NOT NULL,
	"event" text NOT NULL,
	"branch" text NOT NULL,
	"head_ref" text NOT NULL,
	"default_branch" text NOT NULL,
	"sha" text NOT NULL,
	"base_sha" text,
	"pull_number" integer,
	"head_repo_full_name" text,
	"from_fork" boolean DEFAULT false NOT NULL,
	"actor_login" text,
	"status" text NOT NULL,
	"status_reason" text,
	"dedupe_key" text NOT NULL,
	"proxy_run_id" text,
	"check_run_id" bigint,
	"decided_by_user_id" text,
	"decided_at" timestamp,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp DEFAULT now() NOT NULL,
	"jobs" jsonb,
	"vcpu_seconds" double precision,
	"memory_gib_seconds" double precision,
	"usage_reported_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"finished_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ci_storage_samples" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"owner_key" text NOT NULL,
	"hour" timestamp NOT NULL,
	"bytes" bigint NOT NULL,
	"reported_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_features" ADD CONSTRAINT "organization_features_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_accounts" ADD CONSTRAINT "ci_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_accounts" ADD CONSTRAINT "ci_accounts_enabled_by_user_id_users_id_fk" FOREIGN KEY ("enabled_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD CONSTRAINT "ci_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD CONSTRAINT "ci_runs_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_storage_samples" ADD CONSTRAINT "ci_storage_samples_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ci_accounts_installation_idx" ON "ci_accounts" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX "ci_accounts_org_idx" ON "ci_accounts" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ci_runs_dedupe_idx" ON "ci_runs" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "ci_runs_org_created_idx" ON "ci_runs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "ci_runs_status_idx" ON "ci_runs" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ci_storage_samples_owner_hour_idx" ON "ci_storage_samples" USING btree ("owner_key","hour");