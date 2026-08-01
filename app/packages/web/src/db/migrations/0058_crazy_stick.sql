CREATE TABLE "provider_status_feeds" (
	"plugin_id" text PRIMARY KEY NOT NULL,
	"next_fetch_at" timestamp,
	"last_fetched_at" timestamp,
	"last_status" text,
	"last_error" text,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_status_incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"plugin_id" text NOT NULL,
	"external_id" text NOT NULL,
	"title" text NOT NULL,
	"state" text NOT NULL,
	"impact" text NOT NULL,
	"url" text,
	"started_at" timestamp NOT NULL,
	"resolved_at" timestamp,
	"last_update_at" timestamp,
	"last_update_text" text,
	"regions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"services" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resource_type_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provider_wide" boolean DEFAULT false NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_status_notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"incident_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"affected_resource_count" integer DEFAULT 0 NOT NULL,
	"notified_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "msteams_webhooks" ADD COLUMN "provider_incidents" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "push_preferences" ADD COLUMN "provider_incidents" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_channels" ADD COLUMN "provider_incidents" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_status_notifications" ADD CONSTRAINT "provider_status_notifications_incident_id_provider_status_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."provider_status_incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_status_notifications" ADD CONSTRAINT "provider_status_notifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_status_feeds_due_idx" ON "provider_status_feeds" USING btree ("next_fetch_at");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_status_incidents_plugin_external_unique" ON "provider_status_incidents" USING btree ("plugin_id","external_id");--> statement-breakpoint
CREATE INDEX "provider_status_incidents_active_idx" ON "provider_status_incidents" USING btree ("resolved_at","plugin_id");--> statement-breakpoint
CREATE INDEX "provider_status_incidents_started_idx" ON "provider_status_incidents" USING btree ("started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_status_notifications_incident_org_unique" ON "provider_status_notifications" USING btree ("incident_id","organization_id");--> statement-breakpoint
CREATE INDEX "provider_status_notifications_org_idx" ON "provider_status_notifications" USING btree ("organization_id");