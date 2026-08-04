CREATE TABLE "org_posture_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_notified_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "msteams_webhooks" ADD COLUMN "posture_alerts" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "push_preferences" ADD COLUMN "posture_alerts" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_channels" ADD COLUMN "posture_alerts" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "org_posture_settings" ADD CONSTRAINT "org_posture_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;