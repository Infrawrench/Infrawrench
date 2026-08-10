-- NOTE: drizzle-kit generated this file against snapshots that predated the
-- hand-written 0079_alert_routing_rules.sql, so it also re-emitted DDL 0079 had
-- already applied (the two alert tables, their indexes and FKs, and the
-- muted_triggers column). Those statements are removed here — against any
-- database that ran 0079 they would abort the whole migration on the first
-- CREATE TABLE. The DROP COLUMN reconciliation below is kept deliberately:
-- the per-trigger boolean columns were replaced by alert routing in 0079,
-- which migrated their data but never dropped them. The 0088 snapshot
-- reflects the full current schema, ending the drift that caused this.

CREATE TABLE "report_notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"cost_report_id" text NOT NULL,
	"cadence" text DEFAULT 'weekly' NOT NULL,
	"send_day" integer DEFAULT 1 NOT NULL,
	"send_day_of_month" integer DEFAULT 1 NOT NULL,
	"hour" integer DEFAULT 8 NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"slack_channel_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"teams_webhook_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"email_recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_send_at" timestamp,
	"last_sent_at" timestamp,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp,
	"last_status" text,
	"last_error" text,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "report_notifications_hour_range" CHECK ("report_notifications"."hour" >= 0 AND "report_notifications"."hour" <= 23),
	CONSTRAINT "report_notifications_send_day_range" CHECK ("report_notifications"."send_day" >= 1 AND "report_notifications"."send_day" <= 7),
	CONSTRAINT "report_notifications_day_of_month_range" CHECK ("report_notifications"."send_day_of_month" >= 1 AND "report_notifications"."send_day_of_month" <= 31)
);
--> statement-breakpoint
CREATE TABLE "account_commitment_polls" (
	"account_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"last_polled_at" timestamp,
	"next_poll_at" timestamp,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "account_commitments" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"account_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	"commitment_id" text NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"scope" text,
	"region" text,
	"start_date" timestamp,
	"end_date" timestamp,
	"term_days" integer,
	"payment_option" text,
	"currency" text,
	"upfront_amount" double precision,
	"recurring_amount" double precision,
	"recurring_period" text,
	"hourly_commitment_amount" double precision,
	"unit_commitments" jsonb,
	"state" text NOT NULL,
	"provider_utilization" jsonb,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "report_notifications" ADD CONSTRAINT "report_notifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_notifications" ADD CONSTRAINT "report_notifications_cost_report_id_cost_reports_id_fk" FOREIGN KEY ("cost_report_id") REFERENCES "public"."cost_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_commitment_polls" ADD CONSTRAINT "account_commitment_polls_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_commitment_polls" ADD CONSTRAINT "account_commitment_polls_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_commitments" ADD CONSTRAINT "account_commitments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_commitments" ADD CONSTRAINT "account_commitments_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_notifications_org_idx" ON "report_notifications" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "report_notifications_report_idx" ON "report_notifications" USING btree ("cost_report_id");--> statement-breakpoint
CREATE INDEX "report_notifications_due_idx" ON "report_notifications" USING btree ("next_send_at");--> statement-breakpoint
CREATE INDEX "account_commitment_polls_due_idx" ON "account_commitment_polls" USING btree ("next_poll_at");--> statement-breakpoint
CREATE INDEX "account_commitment_polls_org_idx" ON "account_commitment_polls" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_commitments_account_commitment_unique" ON "account_commitments" USING btree ("account_id","commitment_id");--> statement-breakpoint
CREATE INDEX "account_commitments_org_idx" ON "account_commitments" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "msteams_webhooks" DROP COLUMN "sync_incidents";--> statement-breakpoint
ALTER TABLE "msteams_webhooks" DROP COLUMN "budget_alerts";--> statement-breakpoint
ALTER TABLE "msteams_webhooks" DROP COLUMN "anomaly_alerts";--> statement-breakpoint
ALTER TABLE "msteams_webhooks" DROP COLUMN "metric_alerts";--> statement-breakpoint
ALTER TABLE "msteams_webhooks" DROP COLUMN "resource_drift";--> statement-breakpoint
ALTER TABLE "msteams_webhooks" DROP COLUMN "workflow_pages";--> statement-breakpoint
ALTER TABLE "msteams_webhooks" DROP COLUMN "provider_incidents";--> statement-breakpoint
ALTER TABLE "msteams_webhooks" DROP COLUMN "expiry_alerts";--> statement-breakpoint
ALTER TABLE "msteams_webhooks" DROP COLUMN "log_match_alerts";--> statement-breakpoint
ALTER TABLE "msteams_webhooks" DROP COLUMN "posture_alerts";--> statement-breakpoint
ALTER TABLE "msteams_webhooks" DROP COLUMN "probe_alerts";--> statement-breakpoint
ALTER TABLE "msteams_webhooks" DROP COLUMN "weekly_digest";--> statement-breakpoint
ALTER TABLE "push_preferences" DROP COLUMN "sync_incidents";--> statement-breakpoint
ALTER TABLE "push_preferences" DROP COLUMN "budget_alerts";--> statement-breakpoint
ALTER TABLE "push_preferences" DROP COLUMN "anomaly_alerts";--> statement-breakpoint
ALTER TABLE "push_preferences" DROP COLUMN "metric_alerts";--> statement-breakpoint
ALTER TABLE "push_preferences" DROP COLUMN "resource_drift";--> statement-breakpoint
ALTER TABLE "push_preferences" DROP COLUMN "workflow_pages";--> statement-breakpoint
ALTER TABLE "push_preferences" DROP COLUMN "provider_incidents";--> statement-breakpoint
ALTER TABLE "push_preferences" DROP COLUMN "expiry_alerts";--> statement-breakpoint
ALTER TABLE "push_preferences" DROP COLUMN "log_match_alerts";--> statement-breakpoint
ALTER TABLE "push_preferences" DROP COLUMN "posture_alerts";--> statement-breakpoint
ALTER TABLE "push_preferences" DROP COLUMN "probe_alerts";--> statement-breakpoint
ALTER TABLE "slack_channels" DROP COLUMN "sync_incidents";--> statement-breakpoint
ALTER TABLE "slack_channels" DROP COLUMN "budget_alerts";--> statement-breakpoint
ALTER TABLE "slack_channels" DROP COLUMN "anomaly_alerts";--> statement-breakpoint
ALTER TABLE "slack_channels" DROP COLUMN "metric_alerts";--> statement-breakpoint
ALTER TABLE "slack_channels" DROP COLUMN "resource_drift";--> statement-breakpoint
ALTER TABLE "slack_channels" DROP COLUMN "workflow_pages";--> statement-breakpoint
ALTER TABLE "slack_channels" DROP COLUMN "provider_incidents";--> statement-breakpoint
ALTER TABLE "slack_channels" DROP COLUMN "expiry_alerts";--> statement-breakpoint
ALTER TABLE "slack_channels" DROP COLUMN "log_match_alerts";--> statement-breakpoint
ALTER TABLE "slack_channels" DROP COLUMN "posture_alerts";--> statement-breakpoint
ALTER TABLE "slack_channels" DROP COLUMN "probe_alerts";--> statement-breakpoint
ALTER TABLE "slack_channels" DROP COLUMN "weekly_digest";