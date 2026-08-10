CREATE TABLE "org_cost_anomaly_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"sigmas" double precision DEFAULT 3 NOT NULL,
	"min_delta_cents" integer DEFAULT 1000 NOT NULL,
	"new_source_min_cents" integer DEFAULT 2500 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cost_anomalies" ADD COLUMN "kind" text DEFAULT 'spike' NOT NULL;--> statement-breakpoint
ALTER TABLE "org_cost_anomaly_settings" ADD CONSTRAINT "org_cost_anomaly_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;