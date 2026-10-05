CREATE TABLE "alert_email_suppressions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_alert_email_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"external_policy" text DEFAULT 'member-domains' NOT NULL,
	"allowed_domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "budgets" ADD COLUMN "email_recipients" jsonb DEFAULT '{"userIds":[],"addresses":[]}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_alerts" ADD COLUMN "email_recipients" jsonb DEFAULT '{"userIds":[],"addresses":[]}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "org_cost_anomaly_settings" ADD COLUMN "email_recipients" jsonb DEFAULT '{"userIds":[],"addresses":[]}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "org_cost_efficiency_settings" ADD COLUMN "email_recipients" jsonb DEFAULT '{"userIds":[],"addresses":[]}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "alert_email_suppressions" ADD CONSTRAINT "alert_email_suppressions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_alert_email_settings" ADD CONSTRAINT "org_alert_email_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alert_email_suppressions_org_email_unique" ON "alert_email_suppressions" USING btree ("organization_id","email");