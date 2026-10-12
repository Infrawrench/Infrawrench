CREATE TABLE "account_vulnerability_findings" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"account_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	"finding_id" text NOT NULL,
	"advisory_id" text NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"title" text,
	"severity" text NOT NULL,
	"cvss_score" double precision,
	"cvss_vector" text,
	"package_name" text,
	"package_ecosystem" text,
	"installed_version" text,
	"fixed_version" text,
	"fix_available" boolean,
	"exploit_available" boolean,
	"artifact_kind" text NOT NULL,
	"artifact_name" text NOT NULL,
	"artifact_digest" text,
	"artifact_tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"artifact_resource_id" text,
	"artifact_url" text,
	"first_seen_at" timestamp,
	"last_seen_at" timestamp,
	"url" text,
	"collected_at" timestamp DEFAULT now() NOT NULL,
	"alerted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_vulnerability_polls" (
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
CREATE TABLE "kev_vulnerabilities" (
	"cve_id" text PRIMARY KEY NOT NULL,
	"vendor_project" text,
	"product" text,
	"name" text,
	"date_added" date NOT NULL,
	"due_date" date,
	"known_ransomware" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_vulnerability_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"min_severity" text DEFAULT 'critical' NOT NULL,
	"running_only" boolean DEFAULT true NOT NULL,
	"last_notified_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vulnerability_dismissals" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"advisory_id" text NOT NULL,
	"artifact_key" text NOT NULL,
	"reason" text,
	"dismissed_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_vulnerability_findings" ADD CONSTRAINT "account_vulnerability_findings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_vulnerability_findings" ADD CONSTRAINT "account_vulnerability_findings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_vulnerability_polls" ADD CONSTRAINT "account_vulnerability_polls_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_vulnerability_polls" ADD CONSTRAINT "account_vulnerability_polls_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_vulnerability_settings" ADD CONSTRAINT "org_vulnerability_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vulnerability_dismissals" ADD CONSTRAINT "vulnerability_dismissals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vulnerability_dismissals" ADD CONSTRAINT "vulnerability_dismissals_dismissed_by_users_id_fk" FOREIGN KEY ("dismissed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_vulnerability_findings_account_finding_unique" ON "account_vulnerability_findings" USING btree ("account_id","finding_id");--> statement-breakpoint
CREATE INDEX "account_vulnerability_findings_org_severity_idx" ON "account_vulnerability_findings" USING btree ("organization_id","severity");--> statement-breakpoint
CREATE INDEX "account_vulnerability_polls_due_idx" ON "account_vulnerability_polls" USING btree ("next_poll_at");--> statement-breakpoint
CREATE INDEX "account_vulnerability_polls_org_idx" ON "account_vulnerability_polls" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vulnerability_dismissals_key_idx" ON "vulnerability_dismissals" USING btree ("organization_id","advisory_id","artifact_key");