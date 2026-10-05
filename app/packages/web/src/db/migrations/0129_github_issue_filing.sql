CREATE TABLE "github_issue_links" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"installation_id" integer NOT NULL,
	"repo" text NOT NULL,
	"issue_number" integer NOT NULL,
	"issue_url" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"auto_filed" boolean DEFAULT false NOT NULL,
	"pull_request_number" integer,
	"pull_request_url" text,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp,
	CONSTRAINT "github_issue_links_state_valid" CHECK ("github_issue_links"."state" IN ('open', 'closed')),
	CONSTRAINT "github_issue_links_source_kind_valid" CHECK ("github_issue_links"."source_kind" IN ('cost_anomaly', 'orphan', 'oversized', 'posture_finding', 'expiring', 'probe', 'commitment_idle'))
);
--> statement-breakpoint
CREATE TABLE "github_issue_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"default_repo" jsonb,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"assignees" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"routes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resolve_action" text DEFAULT 'comment' NOT NULL,
	"pull_requests_enabled" boolean DEFAULT false NOT NULL,
	"iac_sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "github_issue_settings_resolve_action_valid" CHECK ("github_issue_settings"."resolve_action" IN ('close', 'comment', 'none'))
);
--> statement-breakpoint
CREATE TABLE "savings_finding_scans" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"last_scan_at" timestamp,
	"baselined_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "savings_finding_states" (
	"organization_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "savings_finding_states_organization_id_source_kind_source_id_pk" PRIMARY KEY("organization_id","source_kind","source_id")
);
--> statement-breakpoint
ALTER TABLE "github_issue_links" ADD CONSTRAINT "github_issue_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_issue_settings" ADD CONSTRAINT "github_issue_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_finding_scans" ADD CONSTRAINT "savings_finding_scans_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_finding_states" ADD CONSTRAINT "savings_finding_states_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "github_issue_links_open_fingerprint_unique" ON "github_issue_links" USING btree ("organization_id","fingerprint") WHERE "github_issue_links"."state" = 'open';--> statement-breakpoint
CREATE INDEX "github_issue_links_org_kind_idx" ON "github_issue_links" USING btree ("organization_id","source_kind");