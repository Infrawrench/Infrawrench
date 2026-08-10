CREATE TABLE "linear_integrations" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"encrypted_api_key" text NOT NULL,
	"api_key_iv" text NOT NULL,
	"key_hint" text NOT NULL,
	"default_team_id" text,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "linear_issue_links" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"issue_identifier" text NOT NULL,
	"issue_url" text NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "linear_issue_links_source_kind_valid" CHECK ("linear_issue_links"."source_kind" IN ('cost_anomaly', 'orphan', 'oversized', 'posture_finding', 'expiring', 'probe'))
);
--> statement-breakpoint
ALTER TABLE "linear_integrations" ADD CONSTRAINT "linear_integrations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linear_issue_links" ADD CONSTRAINT "linear_issue_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "linear_issue_links_org_source_issue_unique" ON "linear_issue_links" USING btree ("organization_id","source_kind","source_id","issue_identifier");--> statement-breakpoint
CREATE INDEX "linear_issue_links_org_kind_idx" ON "linear_issue_links" USING btree ("organization_id","source_kind");