ALTER TABLE "jira_issue_links" DROP CONSTRAINT "jira_issue_links_source_kind_valid";--> statement-breakpoint
ALTER TABLE "linear_issue_links" DROP CONSTRAINT "linear_issue_links_source_kind_valid";--> statement-breakpoint
ALTER TABLE "github_issue_links" DROP CONSTRAINT "github_issue_links_source_kind_valid";--> statement-breakpoint
ALTER TABLE "jira_integrations" ADD COLUMN "acknowledge_on_done" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "jira_integrations" ADD COLUMN "webhook_token" text;--> statement-breakpoint
ALTER TABLE "jira_integrations" ADD COLUMN "webhook_mode" text;--> statement-breakpoint
ALTER TABLE "jira_integrations" ADD COLUMN "webhook_remote_id" text;--> statement-breakpoint
ALTER TABLE "jira_integrations" ADD COLUMN "encrypted_webhook_secret" text;--> statement-breakpoint
ALTER TABLE "jira_integrations" ADD COLUMN "webhook_secret_iv" text;--> statement-breakpoint
ALTER TABLE "jira_integrations" ADD COLUMN "webhook_last_delivery_at" timestamp;--> statement-breakpoint
ALTER TABLE "jira_issue_links" ADD COLUMN "issue_id" text;--> statement-breakpoint
ALTER TABLE "jira_issue_links" ADD COLUMN "status" text;--> statement-breakpoint
ALTER TABLE "jira_issue_links" ADD COLUMN "status_category" text;--> statement-breakpoint
ALTER TABLE "jira_issue_links" ADD COLUMN "assignee" text;--> statement-breakpoint
ALTER TABLE "jira_issue_links" ADD COLUMN "issue_updated_at" timestamp;--> statement-breakpoint
ALTER TABLE "jira_issue_links" ADD COLUMN "status_synced_at" timestamp;--> statement-breakpoint
ALTER TABLE "linear_integrations" ADD COLUMN "acknowledge_on_done" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "linear_integrations" ADD COLUMN "webhook_token" text;--> statement-breakpoint
ALTER TABLE "linear_integrations" ADD COLUMN "webhook_mode" text;--> statement-breakpoint
ALTER TABLE "linear_integrations" ADD COLUMN "webhook_remote_id" text;--> statement-breakpoint
ALTER TABLE "linear_integrations" ADD COLUMN "encrypted_webhook_secret" text;--> statement-breakpoint
ALTER TABLE "linear_integrations" ADD COLUMN "webhook_secret_iv" text;--> statement-breakpoint
ALTER TABLE "linear_integrations" ADD COLUMN "webhook_last_delivery_at" timestamp;--> statement-breakpoint
ALTER TABLE "linear_issue_links" ADD COLUMN "issue_id" text;--> statement-breakpoint
ALTER TABLE "linear_issue_links" ADD COLUMN "status" text;--> statement-breakpoint
ALTER TABLE "linear_issue_links" ADD COLUMN "status_category" text;--> statement-breakpoint
ALTER TABLE "linear_issue_links" ADD COLUMN "assignee" text;--> statement-breakpoint
ALTER TABLE "linear_issue_links" ADD COLUMN "issue_updated_at" timestamp;--> statement-breakpoint
ALTER TABLE "linear_issue_links" ADD COLUMN "status_synced_at" timestamp;--> statement-breakpoint
ALTER TABLE "github_issue_links" ADD COLUMN "status" text;--> statement-breakpoint
ALTER TABLE "github_issue_links" ADD COLUMN "status_category" text;--> statement-breakpoint
ALTER TABLE "github_issue_links" ADD COLUMN "assignee" text;--> statement-breakpoint
ALTER TABLE "github_issue_links" ADD COLUMN "issue_updated_at" timestamp;--> statement-breakpoint
ALTER TABLE "github_issue_links" ADD COLUMN "status_synced_at" timestamp;--> statement-breakpoint
ALTER TABLE "github_issue_settings" ADD COLUMN "acknowledge_on_done" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "jira_issue_links_org_issue_key_idx" ON "jira_issue_links" USING btree ("organization_id","issue_key");--> statement-breakpoint
CREATE INDEX "jira_issue_links_status_synced_idx" ON "jira_issue_links" USING btree ("status_synced_at");--> statement-breakpoint
CREATE INDEX "linear_issue_links_org_identifier_idx" ON "linear_issue_links" USING btree ("organization_id","issue_identifier");--> statement-breakpoint
CREATE INDEX "linear_issue_links_status_synced_idx" ON "linear_issue_links" USING btree ("status_synced_at");--> statement-breakpoint
CREATE INDEX "github_issue_links_issue_idx" ON "github_issue_links" USING btree ("installation_id","repo","issue_number");--> statement-breakpoint
CREATE INDEX "github_issue_links_status_synced_idx" ON "github_issue_links" USING btree ("status_synced_at");--> statement-breakpoint
ALTER TABLE "jira_integrations" ADD CONSTRAINT "jira_integrations_webhook_token_unique" UNIQUE("webhook_token");--> statement-breakpoint
ALTER TABLE "linear_integrations" ADD CONSTRAINT "linear_integrations_webhook_token_unique" UNIQUE("webhook_token");--> statement-breakpoint
ALTER TABLE "jira_issue_links" ADD CONSTRAINT "jira_issue_links_status_category_valid" CHECK ("jira_issue_links"."status_category" IS NULL OR "jira_issue_links"."status_category" IN ('todo', 'in_progress', 'done', 'canceled'));--> statement-breakpoint
ALTER TABLE "jira_issue_links" ADD CONSTRAINT "jira_issue_links_source_kind_valid" CHECK ("jira_issue_links"."source_kind" IN ('cost_anomaly', 'orphan', 'oversized', 'posture_finding', 'expiring', 'probe', 'extended_support', 'budget_alert'));--> statement-breakpoint
ALTER TABLE "linear_issue_links" ADD CONSTRAINT "linear_issue_links_status_category_valid" CHECK ("linear_issue_links"."status_category" IS NULL OR "linear_issue_links"."status_category" IN ('todo', 'in_progress', 'done', 'canceled'));--> statement-breakpoint
ALTER TABLE "linear_issue_links" ADD CONSTRAINT "linear_issue_links_source_kind_valid" CHECK ("linear_issue_links"."source_kind" IN ('cost_anomaly', 'orphan', 'oversized', 'posture_finding', 'expiring', 'probe', 'extended_support', 'budget_alert'));--> statement-breakpoint
ALTER TABLE "github_issue_links" ADD CONSTRAINT "github_issue_links_status_category_valid" CHECK ("github_issue_links"."status_category" IS NULL OR "github_issue_links"."status_category" IN ('todo', 'in_progress', 'done', 'canceled'));--> statement-breakpoint
ALTER TABLE "github_issue_links" ADD CONSTRAINT "github_issue_links_source_kind_valid" CHECK ("github_issue_links"."source_kind" IN ('cost_anomaly', 'orphan', 'oversized', 'posture_finding', 'expiring', 'probe', 'extended_support', 'budget_alert', 'commitment_idle'));