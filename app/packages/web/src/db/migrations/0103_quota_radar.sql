CREATE TABLE "account_quota_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"account_id" text NOT NULL,
	"quota_key" text NOT NULL,
	"service" text NOT NULL,
	"name" text NOT NULL,
	"region" text,
	"quota_limit" double precision NOT NULL,
	"used" double precision NOT NULL,
	"utilization" double precision NOT NULL,
	"unit" text,
	"adjustable" boolean,
	"docs_url" text,
	"observed_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_quota_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"account_id" text NOT NULL,
	"quota_key" text NOT NULL,
	"quota_limit" double precision NOT NULL,
	"used" double precision NOT NULL,
	"utilization" double precision NOT NULL,
	"observed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_quota_polls" (
	"account_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"last_polled_at" timestamp,
	"next_poll_at" timestamp,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_error_help_label" text,
	"last_error_help_url" text
);
--> statement-breakpoint
CREATE TABLE "org_quota_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"threshold" double precision DEFAULT 0.8 NOT NULL,
	"last_notified_at" timestamp,
	"updated_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_quota_usage" ADD CONSTRAINT "account_quota_usage_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_quota_usage" ADD CONSTRAINT "account_quota_usage_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_quota_snapshots" ADD CONSTRAINT "account_quota_snapshots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_quota_snapshots" ADD CONSTRAINT "account_quota_snapshots_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_quota_polls" ADD CONSTRAINT "account_quota_polls_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_quota_polls" ADD CONSTRAINT "account_quota_polls_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_quota_settings" ADD CONSTRAINT "org_quota_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_quota_settings" ADD CONSTRAINT "org_quota_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_quota_usage_account_quota_unique" ON "account_quota_usage" USING btree ("account_id","quota_key");--> statement-breakpoint
CREATE INDEX "account_quota_usage_org_utilization_idx" ON "account_quota_usage" USING btree ("organization_id","utilization");--> statement-breakpoint
CREATE INDEX "account_quota_snapshots_account_quota_observed_idx" ON "account_quota_snapshots" USING btree ("account_id","quota_key","observed_at");--> statement-breakpoint
CREATE INDEX "account_quota_snapshots_org_observed_idx" ON "account_quota_snapshots" USING btree ("organization_id","observed_at");--> statement-breakpoint
CREATE INDEX "account_quota_polls_due_idx" ON "account_quota_polls" USING btree ("next_poll_at");--> statement-breakpoint
CREATE INDEX "account_quota_polls_org_idx" ON "account_quota_polls" USING btree ("organization_id");
