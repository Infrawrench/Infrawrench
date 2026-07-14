CREATE TABLE "agent_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"repo" text NOT NULL,
	"project_name" text NOT NULL,
	"workspace_name" text NOT NULL,
	"account_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	"resource_type_id" text NOT NULL,
	"tool" text DEFAULT 'codex' NOT NULL,
	"branch_name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"vm_resource_id" text,
	"logs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"setup_plan_json" text DEFAULT '{}' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"account_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	"resource_type_id" text NOT NULL,
	"tool" text DEFAULT 'codex' NOT NULL,
	"fields_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_settings" ADD CONSTRAINT "agent_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_settings" ADD CONSTRAINT "agent_settings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_sessions_org_idx" ON "agent_sessions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "agent_sessions_status_idx" ON "agent_sessions" USING btree ("status");