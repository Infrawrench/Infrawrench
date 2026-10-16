CREATE TABLE "cost_export_job_chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"seq" integer NOT NULL,
	"payload" text NOT NULL,
	"byte_length" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_export_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"created_by_user_id" text,
	"principal" jsonb NOT NULL,
	"source" jsonb NOT NULL,
	"format" text NOT NULL,
	"focus_version" text,
	"from_day" text NOT NULL,
	"to_day" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"progress" double precision DEFAULT 0 NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"byte_count" double precision DEFAULT 0 NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp,
	"started_at" timestamp,
	"finished_at" timestamp,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_report_anomalies" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"alert_id" text NOT NULL,
	"day" text NOT NULL,
	"currency" text NOT NULL,
	"actual_amount" double precision NOT NULL,
	"baseline_amount" double precision NOT NULL,
	"threshold_amount" double precision NOT NULL,
	"notified_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_report_anomaly_alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"cost_report_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sigmas" double precision DEFAULT 3 NOT NULL,
	"min_delta_cents" integer DEFAULT 1000 NOT NULL,
	"destinations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"visibility_user_id" text,
	"created_by_user_id" text,
	"last_evaluated_at" timestamp,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "cost_report_anomaly_alerts_sigmas_range" CHECK ("cost_report_anomaly_alerts"."sigmas" >= 1 AND "cost_report_anomaly_alerts"."sigmas" <= 10)
);
--> statement-breakpoint
ALTER TABLE "cost_export_job_chunks" ADD CONSTRAINT "cost_export_job_chunks_job_id_cost_export_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."cost_export_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_export_job_chunks" ADD CONSTRAINT "cost_export_job_chunks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_export_jobs" ADD CONSTRAINT "cost_export_jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_export_jobs" ADD CONSTRAINT "cost_export_jobs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_report_anomalies" ADD CONSTRAINT "cost_report_anomalies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_report_anomalies" ADD CONSTRAINT "cost_report_anomalies_alert_id_cost_report_anomaly_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."cost_report_anomaly_alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_report_anomaly_alerts" ADD CONSTRAINT "cost_report_anomaly_alerts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_report_anomaly_alerts" ADD CONSTRAINT "cost_report_anomaly_alerts_cost_report_id_cost_reports_id_fk" FOREIGN KEY ("cost_report_id") REFERENCES "public"."cost_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cost_export_job_chunks_job_seq_unique" ON "cost_export_job_chunks" USING btree ("job_id","seq");--> statement-breakpoint
CREATE INDEX "cost_export_jobs_org_user_idx" ON "cost_export_jobs" USING btree ("organization_id","created_by_user_id","created_at");--> statement-breakpoint
CREATE INDEX "cost_export_jobs_claim_idx" ON "cost_export_jobs" USING btree ("status","lease_until");--> statement-breakpoint
CREATE INDEX "cost_export_jobs_expiry_idx" ON "cost_export_jobs" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cost_report_anomalies_alert_day_unique" ON "cost_report_anomalies" USING btree ("alert_id","day","currency");--> statement-breakpoint
CREATE UNIQUE INDEX "cost_report_anomaly_alerts_report_unique" ON "cost_report_anomaly_alerts" USING btree ("cost_report_id");--> statement-breakpoint
CREATE INDEX "cost_report_anomaly_alerts_org_idx" ON "cost_report_anomaly_alerts" USING btree ("organization_id");