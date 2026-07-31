CREATE TABLE "org_drift_alert_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"notify_created" boolean DEFAULT true NOT NULL,
	"notify_updated" boolean DEFAULT false NOT NULL,
	"notify_deleted" boolean DEFAULT true NOT NULL,
	"cooldown_minutes" integer DEFAULT 60 NOT NULL,
	"min_changes" integer DEFAULT 1 NOT NULL,
	"account_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_notified_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "msteams_webhooks" ADD COLUMN "resource_drift" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "push_preferences" ADD COLUMN "resource_drift" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_channels" ADD COLUMN "resource_drift" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "org_drift_alert_settings" ADD CONSTRAINT "org_drift_alert_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;