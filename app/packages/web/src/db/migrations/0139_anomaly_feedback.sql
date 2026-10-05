CREATE TABLE "cost_anomaly_suppressions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"scope" text NOT NULL,
	"scope_key" text NOT NULL,
	"tag_key" text,
	"recurrence" text NOT NULL,
	"anchor_day" text NOT NULL,
	"starts_on" text NOT NULL,
	"expires_on" text NOT NULL,
	"reason" text,
	"note" text,
	"source_anomaly_id" text,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cost_anomalies" ADD COLUMN "feedback_verdict" text;--> statement-breakpoint
ALTER TABLE "cost_anomalies" ADD COLUMN "feedback_reason" text;--> statement-breakpoint
ALTER TABLE "cost_anomalies" ADD COLUMN "feedback_note" text;--> statement-breakpoint
ALTER TABLE "cost_anomalies" ADD COLUMN "feedback_at" timestamp;--> statement-breakpoint
ALTER TABLE "cost_anomalies" ADD COLUMN "feedback_by_user_id" text;--> statement-breakpoint
ALTER TABLE "cost_anomalies" ADD COLUMN "feedback_suppression_id" text;--> statement-breakpoint
ALTER TABLE "cost_anomalies" ADD COLUMN "suppressed_by_id" text;--> statement-breakpoint
ALTER TABLE "org_cost_anomaly_settings" ADD COLUMN "feedback_tuning" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_anomaly_suppressions" ADD CONSTRAINT "cost_anomaly_suppressions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_anomaly_suppressions" ADD CONSTRAINT "cost_anomaly_suppressions_source_anomaly_id_cost_anomalies_id_fk" FOREIGN KEY ("source_anomaly_id") REFERENCES "public"."cost_anomalies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_anomaly_suppressions" ADD CONSTRAINT "cost_anomaly_suppressions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cost_anomaly_suppressions_org_expires_idx" ON "cost_anomaly_suppressions" USING btree ("organization_id","expires_on");--> statement-breakpoint
ALTER TABLE "cost_anomalies" ADD CONSTRAINT "cost_anomalies_feedback_by_user_id_users_id_fk" FOREIGN KEY ("feedback_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_anomalies" ADD CONSTRAINT "cost_anomalies_feedback_suppression_id_cost_anomaly_suppressions_id_fk" FOREIGN KEY ("feedback_suppression_id") REFERENCES "public"."cost_anomaly_suppressions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_anomalies" ADD CONSTRAINT "cost_anomalies_suppressed_by_id_cost_anomaly_suppressions_id_fk" FOREIGN KEY ("suppressed_by_id") REFERENCES "public"."cost_anomaly_suppressions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cost_anomalies_suppressed_by_idx" ON "cost_anomalies" USING btree ("suppressed_by_id") WHERE suppressed_by_id is not null;--> statement-breakpoint
CREATE INDEX "cost_anomalies_feedback_suppression_idx" ON "cost_anomalies" USING btree ("feedback_suppression_id") WHERE feedback_suppression_id is not null;--> statement-breakpoint
CREATE INDEX "cost_anomalies_org_feedback_at_idx" ON "cost_anomalies" USING btree ("organization_id","feedback_at") WHERE feedback_at is not null;