CREATE TABLE "metric_alert_events" (
	"id" text PRIMARY KEY NOT NULL,
	"rule_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"resource_name" text NOT NULL,
	"status" text DEFAULT 'firing' NOT NULL,
	"observed_value" double precision NOT NULL,
	"fired_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp,
	"notified_at" timestamp,
	"resolved_notified_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "metric_alert_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"plugin_id" text,
	"resource_type_id" text,
	"tag_key" text,
	"tag_value" text,
	"metric_key" text NOT NULL,
	"comparator" text NOT NULL,
	"threshold" double precision NOT NULL,
	"for_minutes" integer DEFAULT 15 NOT NULL,
	"cooldown_minutes" integer DEFAULT 60 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_eval_at" timestamp,
	"last_eval_at" timestamp,
	"created_by_user_id" text,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "metric_alert_rules_for_minutes_positive" CHECK ("metric_alert_rules"."for_minutes" > 0),
	CONSTRAINT "metric_alert_rules_cooldown_non_negative" CHECK ("metric_alert_rules"."cooldown_minutes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "msteams_webhooks" ADD COLUMN "metric_alerts" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "push_preferences" ADD COLUMN "metric_alerts" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_channels" ADD COLUMN "metric_alerts" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "metric_alert_events" ADD CONSTRAINT "metric_alert_events_rule_id_metric_alert_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."metric_alert_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_alert_events" ADD CONSTRAINT "metric_alert_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_alert_rules" ADD CONSTRAINT "metric_alert_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_alert_rules" ADD CONSTRAINT "metric_alert_rules_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "metric_alert_events_open_unique" ON "metric_alert_events" USING btree ("rule_id","resource_id") WHERE status = 'firing';--> statement-breakpoint
CREATE INDEX "metric_alert_events_rule_fired_idx" ON "metric_alert_events" USING btree ("rule_id","fired_at");--> statement-breakpoint
CREATE INDEX "metric_alert_events_org_fired_idx" ON "metric_alert_events" USING btree ("organization_id","fired_at");--> statement-breakpoint
CREATE INDEX "metric_alert_rules_org_idx" ON "metric_alert_rules" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "metric_alert_rules_due_idx" ON "metric_alert_rules" USING btree ("next_eval_at");