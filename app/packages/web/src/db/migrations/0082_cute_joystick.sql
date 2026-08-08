CREATE TABLE "jira_integrations" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"site_url" text NOT NULL,
	"account_email" text NOT NULL,
	"encrypted_api_token" text NOT NULL,
	"api_token_iv" text NOT NULL,
	"token_hint" text NOT NULL,
	"default_project_key" text,
	"default_issue_type_id" text,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jira_issue_links" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"issue_key" text NOT NULL,
	"issue_url" text NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "jira_issue_links_source_kind_valid" CHECK ("jira_issue_links"."source_kind" IN ('cost_anomaly', 'orphan', 'oversized', 'posture_finding', 'expiring', 'probe'))
);
--> statement-breakpoint
ALTER TABLE "jira_integrations" ADD CONSTRAINT "jira_integrations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jira_issue_links" ADD CONSTRAINT "jira_issue_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "jira_issue_links_org_source_issue_unique" ON "jira_issue_links" USING btree ("organization_id","source_kind","source_id","issue_key");--> statement-breakpoint
CREATE INDEX "jira_issue_links_org_kind_idx" ON "jira_issue_links" USING btree ("organization_id","source_kind");