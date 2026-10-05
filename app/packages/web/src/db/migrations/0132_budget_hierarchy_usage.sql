ALTER TABLE "budget_alert_events" ADD COLUMN "period_start" text;--> statement-breakpoint
ALTER TABLE "budget_alert_events" ADD COLUMN "period_end" text;--> statement-breakpoint
ALTER TABLE "budget_alert_events" ADD COLUMN "actual_usage" double precision;--> statement-breakpoint
ALTER TABLE "budget_alert_events" ADD COLUMN "forecast_usage" double precision;--> statement-breakpoint
ALTER TABLE "budgets" ADD COLUMN "measure" text DEFAULT 'cost' NOT NULL;--> statement-breakpoint
ALTER TABLE "budgets" ADD COLUMN "usage_unit" text;--> statement-breakpoint
ALTER TABLE "budgets" ADD COLUMN "usage_amount" double precision;--> statement-breakpoint
ALTER TABLE "budgets" ADD COLUMN "period" jsonb;--> statement-breakpoint
ALTER TABLE "budgets" ADD COLUMN "parent_budget_id" text;--> statement-breakpoint
CREATE INDEX "budgets_parent_idx" ON "budgets" USING btree ("parent_budget_id");