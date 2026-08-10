ALTER TABLE "org_cost_anomaly_settings" ADD COLUMN "sms_alerts" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "org_cost_anomaly_settings" ADD COLUMN "sms_last_paged_at" timestamp;