CREATE TABLE "business_metric_forecast_values" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"metric_id" text NOT NULL,
	"day" date NOT NULL,
	"value" double precision NOT NULL,
	"updated_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_report_forecasts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"cost_report_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"scenario_model_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"driver_metric_id" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "business_metric_forecast_values" ADD CONSTRAINT "business_metric_forecast_values_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_metric_forecast_values" ADD CONSTRAINT "business_metric_forecast_values_metric_id_business_metrics_id_fk" FOREIGN KEY ("metric_id") REFERENCES "public"."business_metrics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_metric_forecast_values" ADD CONSTRAINT "business_metric_forecast_values_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_report_forecasts" ADD CONSTRAINT "cost_report_forecasts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_report_forecasts" ADD CONSTRAINT "cost_report_forecasts_cost_report_id_cost_reports_id_fk" FOREIGN KEY ("cost_report_id") REFERENCES "public"."cost_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_report_forecasts" ADD CONSTRAINT "cost_report_forecasts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "business_metric_forecast_values_metric_day_unique" ON "business_metric_forecast_values" USING btree ("metric_id","day");--> statement-breakpoint
CREATE INDEX "business_metric_forecast_values_org_idx" ON "business_metric_forecast_values" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "cost_report_forecasts_report_idx" ON "cost_report_forecasts" USING btree ("organization_id","cost_report_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cost_report_forecasts_report_name_unique" ON "cost_report_forecasts" USING btree ("cost_report_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "cost_report_forecasts_one_default" ON "cost_report_forecasts" USING btree ("cost_report_id") WHERE is_default;