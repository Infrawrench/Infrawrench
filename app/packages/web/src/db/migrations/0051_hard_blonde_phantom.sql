CREATE TABLE "cost_anomalies" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"day" text NOT NULL,
	"dimension" text NOT NULL,
	"dimension_key" text NOT NULL,
	"currency" text NOT NULL,
	"actual_amount_cents" integer NOT NULL,
	"baseline_amount_cents" integer NOT NULL,
	"threshold_amount_cents" integer NOT NULL,
	"detected_at" timestamp DEFAULT now() NOT NULL,
	"notified_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "msteams_webhooks" ADD COLUMN "anomaly_alerts" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "push_preferences" ADD COLUMN "anomaly_alerts" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_channels" ADD COLUMN "anomaly_alerts" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_anomalies" ADD CONSTRAINT "cost_anomalies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cost_anomalies_once_unique" ON "cost_anomalies" USING btree ("organization_id","day","dimension","dimension_key","currency");--> statement-breakpoint
CREATE INDEX "cost_anomalies_org_day_idx" ON "cost_anomalies" USING btree ("organization_id","day");