CREATE TABLE "org_cost_efficiency_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"commitment_expiry_enabled" boolean DEFAULT true NOT NULL,
	"commitment_expiry_horizon_days" jsonb DEFAULT '[60,30,7]'::jsonb NOT NULL,
	"commitment_expiry_alert_on_expired" boolean DEFAULT true NOT NULL,
	"commitment_idle_enabled" boolean DEFAULT true NOT NULL,
	"commitment_idle_threshold_percent" integer DEFAULT 70 NOT NULL,
	"commitment_idle_window_days" integer DEFAULT 30 NOT NULL,
	"commitment_idle_min_measured_days" integer DEFAULT 14 NOT NULL,
	"commitment_idle_min_waste_cents" integer DEFAULT 5000 NOT NULL,
	"unit_cost_regression_enabled" boolean DEFAULT true NOT NULL,
	"unit_cost_threshold_percent" integer DEFAULT 20 NOT NULL,
	"unit_cost_window_days" integer DEFAULT 14 NOT NULL,
	"unit_cost_min_reported_days" integer DEFAULT 10 NOT NULL,
	"unit_cost_min_spend_cents" integer DEFAULT 10000 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unit_cost_regression_events" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"metric_id" text NOT NULL,
	"currency" text NOT NULL,
	"window_from" text NOT NULL,
	"window_to" text NOT NULL,
	"previous_from" text NOT NULL,
	"previous_to" text NOT NULL,
	"previous_unit_cost" double precision NOT NULL,
	"current_unit_cost" double precision NOT NULL,
	"change_percent" integer NOT NULL,
	"current_spend" double precision NOT NULL,
	"previous_metric_value" double precision NOT NULL,
	"current_metric_value" double precision NOT NULL,
	"previous_reported_days" integer NOT NULL,
	"current_reported_days" integer NOT NULL,
	"fired_at" timestamp DEFAULT now() NOT NULL,
	"notified_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "commitment_expiry_events" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"account_id" text NOT NULL,
	"commitment_id" text NOT NULL,
	"term_end_day" text NOT NULL,
	"horizon_days" integer NOT NULL,
	"description" text NOT NULL,
	"currency" text,
	"hourly_commitment_amount" double precision,
	"on_demand_monthly_amount" double precision,
	"fired_at" timestamp DEFAULT now() NOT NULL,
	"notified_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "commitment_idle_events" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"account_id" text NOT NULL,
	"commitment_id" text NOT NULL,
	"period_key" text NOT NULL,
	"window_from" text NOT NULL,
	"window_to" text NOT NULL,
	"description" text NOT NULL,
	"currency" text,
	"utilization" double precision NOT NULL,
	"obligation_amount" double precision NOT NULL,
	"delivered_amount" double precision NOT NULL,
	"wasted_amount" double precision NOT NULL,
	"measured_days" integer NOT NULL,
	"missing_days" integer NOT NULL,
	"fired_at" timestamp DEFAULT now() NOT NULL,
	"notified_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "org_cost_efficiency_settings" ADD CONSTRAINT "org_cost_efficiency_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_cost_regression_events" ADD CONSTRAINT "unit_cost_regression_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_cost_regression_events" ADD CONSTRAINT "unit_cost_regression_events_metric_id_business_metrics_id_fk" FOREIGN KEY ("metric_id") REFERENCES "public"."business_metrics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitment_expiry_events" ADD CONSTRAINT "commitment_expiry_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitment_expiry_events" ADD CONSTRAINT "commitment_expiry_events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitment_idle_events" ADD CONSTRAINT "commitment_idle_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitment_idle_events" ADD CONSTRAINT "commitment_idle_events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "unit_cost_regression_once_unique" ON "unit_cost_regression_events" USING btree ("metric_id","currency","window_to");--> statement-breakpoint
CREATE INDEX "unit_cost_regression_events_org_fired_idx" ON "unit_cost_regression_events" USING btree ("organization_id","fired_at");--> statement-breakpoint
CREATE UNIQUE INDEX "commitment_expiry_once_unique" ON "commitment_expiry_events" USING btree ("account_id","commitment_id","term_end_day","horizon_days");--> statement-breakpoint
CREATE INDEX "commitment_expiry_events_org_fired_idx" ON "commitment_expiry_events" USING btree ("organization_id","fired_at");--> statement-breakpoint
CREATE UNIQUE INDEX "commitment_idle_once_unique" ON "commitment_idle_events" USING btree ("account_id","commitment_id","period_key");--> statement-breakpoint
CREATE INDEX "commitment_idle_events_org_fired_idx" ON "commitment_idle_events" USING btree ("organization_id","fired_at");