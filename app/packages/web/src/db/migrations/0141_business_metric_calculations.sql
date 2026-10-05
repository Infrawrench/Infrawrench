CREATE TABLE "unit_cost_threshold_events" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"metric_id" text NOT NULL,
	"threshold_key" text NOT NULL,
	"mode" text NOT NULL,
	"direction" text NOT NULL,
	"threshold_value" double precision NOT NULL,
	"scale" integer DEFAULT 1 NOT NULL,
	"label_key" text DEFAULT '' NOT NULL,
	"label_value" text DEFAULT '' NOT NULL,
	"currency" text NOT NULL,
	"window_from" text NOT NULL,
	"window_to" text NOT NULL,
	"observed_value" double precision NOT NULL,
	"window_spend" double precision NOT NULL,
	"fired_at" timestamp DEFAULT now() NOT NULL,
	"notified_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "business_metric_values" ADD COLUMN "labels" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "business_metrics" ADD COLUMN "label_mappings" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "business_metrics" ADD COLUMN "thresholds" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "unit_cost_threshold_events" ADD CONSTRAINT "unit_cost_threshold_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_cost_threshold_events" ADD CONSTRAINT "unit_cost_threshold_events_metric_id_business_metrics_id_fk" FOREIGN KEY ("metric_id") REFERENCES "public"."business_metrics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "unit_cost_threshold_once_unique" ON "unit_cost_threshold_events" USING btree ("metric_id","threshold_key","label_value","currency","window_to");--> statement-breakpoint
CREATE INDEX "unit_cost_threshold_events_org_fired_idx" ON "unit_cost_threshold_events" USING btree ("organization_id","fired_at");