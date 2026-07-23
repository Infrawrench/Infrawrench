CREATE TABLE "budget_alert_events" (
	"id" text PRIMARY KEY NOT NULL,
	"budget_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"month" text NOT NULL,
	"threshold_type" text NOT NULL,
	"threshold_percent" integer NOT NULL,
	"actual_amount_cents" integer NOT NULL,
	"forecast_amount_cents" integer,
	"triggered_at" timestamp DEFAULT now() NOT NULL,
	"notified_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "budgets" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"filters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"thresholds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_user_id" text,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dashboard_widgets" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"dashboard_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"config" jsonb NOT NULL,
	"grid_x" integer DEFAULT 0 NOT NULL,
	"grid_y" integer DEFAULT 0 NOT NULL,
	"grid_w" integer DEFAULT 2 NOT NULL,
	"grid_h" integer DEFAULT 1 NOT NULL,
	"sync_version" integer DEFAULT 0 NOT NULL,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "budget_alert_events" ADD CONSTRAINT "budget_alert_events_budget_id_budgets_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."budgets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_alert_events" ADD CONSTRAINT "budget_alert_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_dashboard_id_dashboards_id_fk" FOREIGN KEY ("dashboard_id") REFERENCES "public"."dashboards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "budget_alert_once_unique" ON "budget_alert_events" USING btree ("budget_id","month","threshold_type","threshold_percent");--> statement-breakpoint
CREATE INDEX "budget_alert_events_org_idx" ON "budget_alert_events" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "budgets_org_idx" ON "budgets" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "dashboard_widgets_dashboard_idx" ON "dashboard_widgets" USING btree ("dashboard_id");--> statement-breakpoint
CREATE INDEX "dashboard_widgets_org_idx" ON "dashboard_widgets" USING btree ("organization_id");