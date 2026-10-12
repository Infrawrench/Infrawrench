CREATE TABLE "vulnerability_resolutions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"account_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	"finding_id" text NOT NULL,
	"advisory_id" text NOT NULL,
	"severity" text NOT NULL,
	"artifact_kind" text NOT NULL,
	"artifact_name" text NOT NULL,
	"first_seen_at" timestamp NOT NULL,
	"resolved_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compliance_control_settings" (
	"organization_id" text NOT NULL,
	"framework_id" text NOT NULL,
	"control_id" text NOT NULL,
	"applicable" boolean DEFAULT true NOT NULL,
	"justification" text,
	"owner_user_id" text,
	"owner_label" text,
	"notes" text,
	"updated_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "compliance_control_settings_organization_id_framework_id_control_id_pk" PRIMARY KEY("organization_id","framework_id","control_id")
);
--> statement-breakpoint
ALTER TABLE "report_notifications" DROP CONSTRAINT "report_notifications_one_target";--> statement-breakpoint
ALTER TABLE "report_notifications" ADD COLUMN "compliance_framework_id" text;--> statement-breakpoint
ALTER TABLE "vulnerability_resolutions" ADD CONSTRAINT "vulnerability_resolutions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_control_settings" ADD CONSTRAINT "compliance_control_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_control_settings" ADD CONSTRAINT "compliance_control_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vulnerability_resolutions_org_resolved_idx" ON "vulnerability_resolutions" USING btree ("organization_id","resolved_at");--> statement-breakpoint
CREATE INDEX "report_notifications_compliance_idx" ON "report_notifications" USING btree ("organization_id","compliance_framework_id");--> statement-breakpoint
ALTER TABLE "report_notifications" ADD CONSTRAINT "report_notifications_one_target" CHECK (num_nonnulls("report_notifications"."cost_report_id", "report_notifications"."dashboard_id", "report_notifications"."cost_canvas_id", "report_notifications"."compliance_framework_id") = 1);