CREATE TABLE "org_extended_support_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"lead_days" integer DEFAULT 90 NOT NULL,
	"last_notified_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jira_issue_links" DROP CONSTRAINT "jira_issue_links_source_kind_valid";--> statement-breakpoint
ALTER TABLE "linear_issue_links" DROP CONSTRAINT "linear_issue_links_source_kind_valid";--> statement-breakpoint
ALTER TABLE "org_extended_support_settings" ADD CONSTRAINT "org_extended_support_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jira_issue_links" ADD CONSTRAINT "jira_issue_links_source_kind_valid" CHECK ("jira_issue_links"."source_kind" IN ('cost_anomaly', 'orphan', 'oversized', 'posture_finding', 'expiring', 'probe', 'extended_support'));--> statement-breakpoint
ALTER TABLE "linear_issue_links" ADD CONSTRAINT "linear_issue_links_source_kind_valid" CHECK ("linear_issue_links"."source_kind" IN ('cost_anomaly', 'orphan', 'oversized', 'posture_finding', 'expiring', 'probe', 'extended_support'));