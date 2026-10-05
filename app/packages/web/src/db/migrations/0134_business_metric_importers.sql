CREATE TABLE "business_metric_import_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"importer_id" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"from_day" date NOT NULL,
	"to_day" date NOT NULL,
	"points_read" integer DEFAULT 0 NOT NULL,
	"days_written" integer DEFAULT 0 NOT NULL,
	"error" text,
	"notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"triggered_by_user_id" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp,
	"duration_ms" integer
);
--> statement-breakpoint
CREATE TABLE "business_metric_importers" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"metric_id" text NOT NULL,
	"account_id" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"schedule" text DEFAULT 'daily' NOT NULL,
	"backfill_days" integer DEFAULT 7 NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"aggregation" text DEFAULT 'sum' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp DEFAULT now() NOT NULL,
	"last_run_at" timestamp,
	"last_status" text,
	"last_error" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "business_metric_values_metric_day_unique";--> statement-breakpoint
ALTER TABLE "business_metric_values" ADD COLUMN "label" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "business_metric_import_runs" ADD CONSTRAINT "business_metric_import_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_metric_import_runs" ADD CONSTRAINT "business_metric_import_runs_importer_id_business_metric_importers_id_fk" FOREIGN KEY ("importer_id") REFERENCES "public"."business_metric_importers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_metric_import_runs" ADD CONSTRAINT "business_metric_import_runs_triggered_by_user_id_users_id_fk" FOREIGN KEY ("triggered_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_metric_importers" ADD CONSTRAINT "business_metric_importers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_metric_importers" ADD CONSTRAINT "business_metric_importers_metric_id_business_metrics_id_fk" FOREIGN KEY ("metric_id") REFERENCES "public"."business_metrics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_metric_importers" ADD CONSTRAINT "business_metric_importers_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "business_metric_import_runs_importer_started_idx" ON "business_metric_import_runs" USING btree ("importer_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "business_metric_importers_metric_unique" ON "business_metric_importers" USING btree ("metric_id");--> statement-breakpoint
CREATE INDEX "business_metric_importers_org_idx" ON "business_metric_importers" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "business_metric_importers_due_idx" ON "business_metric_importers" USING btree ("enabled","next_run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "business_metric_values_metric_day_label_unique" ON "business_metric_values" USING btree ("metric_id","day","label");