CREATE TABLE "account_idle_findings" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"account_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	"rule_id" text NOT NULL,
	"subject_key" text NOT NULL,
	"resource_id" text,
	"resource_type_id" text,
	"display_name" text NOT NULL,
	"subject_label" text,
	"reason" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"estimate" jsonb,
	"fields" jsonb NOT NULL,
	"lookback_days" integer NOT NULL,
	"first_detected_at" timestamp NOT NULL,
	"evaluated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_idle_polls" (
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
CREATE TABLE "org_idle_finding_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"lookback_days" integer DEFAULT 14 NOT NULL,
	"rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_idle_findings" ADD CONSTRAINT "account_idle_findings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_idle_findings" ADD CONSTRAINT "account_idle_findings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_idle_polls" ADD CONSTRAINT "account_idle_polls_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_idle_polls" ADD CONSTRAINT "account_idle_polls_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_idle_finding_settings" ADD CONSTRAINT "org_idle_finding_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_idle_finding_settings" ADD CONSTRAINT "org_idle_finding_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_idle_findings_identity_idx" ON "account_idle_findings" USING btree ("account_id","rule_id","subject_key");--> statement-breakpoint
CREATE INDEX "account_idle_findings_org_idx" ON "account_idle_findings" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "account_idle_polls_due_idx" ON "account_idle_polls" USING btree ("next_poll_at");--> statement-breakpoint
CREATE INDEX "account_idle_polls_org_idx" ON "account_idle_polls" USING btree ("organization_id");