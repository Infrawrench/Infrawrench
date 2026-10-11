CREATE TABLE "deploy_events" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"source" text NOT NULL,
	"external_key" text NOT NULL,
	"account_id" text,
	"plugin_id" text,
	"resource_type_id" text,
	"resource_id" text,
	"target_resource_id" text,
	"kind" text DEFAULT 'deployment' NOT NULL,
	"name" text NOT NULL,
	"environment" text,
	"repository" text,
	"commit_sha" text,
	"commit_at" timestamp with time zone,
	"deployed_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"is_rollback" boolean DEFAULT false NOT NULL,
	"url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dora_commit_times" (
	"organization_id" text NOT NULL,
	"repository" text NOT NULL,
	"commit_sha" text NOT NULL,
	"committed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_dora_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"failure_window_hours" integer DEFAULT 24 NOT NULL,
	"production_environments" jsonb NOT NULL,
	"pipeline_patterns" jsonb NOT NULL,
	"count_failed_deploys" boolean DEFAULT false NOT NULL,
	"include_resource_changes" boolean DEFAULT false NOT NULL,
	"digest_enabled" boolean DEFAULT true NOT NULL,
	"updated_by_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deploy_events" ADD CONSTRAINT "deploy_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deploy_events" ADD CONSTRAINT "deploy_events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dora_commit_times" ADD CONSTRAINT "dora_commit_times_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_dora_settings" ADD CONSTRAINT "org_dora_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_dora_settings" ADD CONSTRAINT "org_dora_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deploy_events_org_key_unique" ON "deploy_events" USING btree ("organization_id","external_key");--> statement-breakpoint
CREATE INDEX "deploy_events_org_deployed_idx" ON "deploy_events" USING btree ("organization_id","deployed_at");--> statement-breakpoint
CREATE INDEX "deploy_events_account_idx" ON "deploy_events" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dora_commit_times_unique" ON "dora_commit_times" USING btree ("organization_id","repository","commit_sha");