-- Change-based cost alerts — the third cost-alert family.
--
-- Budgets fire on an absolute monthly total; anomaly detection fires on
-- statistical outliers against a learned baseline; cost_alerts fire on a
-- configured relative change ("spend on this scope moved more than X% or $Y
-- versus the prior period") on a chosen scope and cadence.
--
-- cost_alert_events records what fired. The unique index makes each
-- (alert, cadence period, group, currency) fire at most once — the
-- budget_alert_events once-per-month unique is the precedent — so windows
-- re-evaluated inside the provider restatement horizon re-fire nothing.
CREATE TABLE "cost_alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"filters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"group_by" text,
	"group_by_tag_key" text,
	"cadence" text NOT NULL,
	"threshold_percent" integer,
	"threshold_amount_cents" integer,
	"direction" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_evaluated_at" timestamp,
	"created_by_user_id" text,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_alert_events" (
	"id" text PRIMARY KEY NOT NULL,
	"alert_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"period_key" text NOT NULL,
	"window_from" text NOT NULL,
	"window_to" text NOT NULL,
	"previous_from" text NOT NULL,
	"previous_to" text NOT NULL,
	"group_key" text DEFAULT '' NOT NULL,
	"currency" text NOT NULL,
	"previous_amount_cents" integer NOT NULL,
	"current_amount_cents" integer NOT NULL,
	"change_percent" integer,
	"direction" text NOT NULL,
	"fired_at" timestamp DEFAULT now() NOT NULL,
	"notified_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "cost_alerts" ADD CONSTRAINT "cost_alerts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_alerts" ADD CONSTRAINT "cost_alerts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_alert_events" ADD CONSTRAINT "cost_alert_events_alert_id_cost_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."cost_alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_alert_events" ADD CONSTRAINT "cost_alert_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cost_alerts_org_idx" ON "cost_alerts" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cost_alert_events_once_unique" ON "cost_alert_events" USING btree ("alert_id","period_key","group_key","currency");--> statement-breakpoint
CREATE INDEX "cost_alert_events_org_idx" ON "cost_alert_events" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "cost_alert_events_alert_idx" ON "cost_alert_events" USING btree ("alert_id");
