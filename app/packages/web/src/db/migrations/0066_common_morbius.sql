ALTER TABLE "metric_alert_events" DROP CONSTRAINT "metric_alert_events_rule_id_metric_alert_rules_id_fk";
--> statement-breakpoint
ALTER TABLE "metric_alert_events" ADD COLUMN "rule_name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "metric_alert_events" ADD CONSTRAINT "metric_alert_events_rule_id_metric_alert_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."metric_alert_rules"("id") ON DELETE restrict ON UPDATE no action;