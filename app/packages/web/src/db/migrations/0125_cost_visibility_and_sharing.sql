CREATE TABLE "cost_visibility_scopes" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"principal_kind" text NOT NULL,
	"principal_id" text NOT NULL,
	"cost_centre_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"account_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"saved_filter_id" text,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "cost_visibility_scopes_kind_check" CHECK ("cost_visibility_scopes"."principal_kind" IN ('role', 'member', 'api_key'))
);
--> statement-breakpoint
CREATE TABLE "object_access_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"object_type" text NOT NULL,
	"object_id" text NOT NULL,
	"principal_kind" text NOT NULL,
	"principal_id" text DEFAULT '' NOT NULL,
	"level" text NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "object_access_grants_kind_check" CHECK ("object_access_grants"."principal_kind" IN ('org', 'member', 'role')),
	CONSTRAINT "object_access_grants_level_check" CHECK (("object_access_grants"."principal_kind" = 'org' AND "object_access_grants"."level" IN ('editor', 'viewer', 'none')) OR ("object_access_grants"."principal_kind" <> 'org' AND "object_access_grants"."level" IN ('owner', 'editor', 'viewer')))
);
--> statement-breakpoint
ALTER TABLE "budgets" ADD COLUMN "visibility_user_id" text;--> statement-breakpoint
ALTER TABLE "cost_alerts" ADD COLUMN "visibility_user_id" text;--> statement-breakpoint
ALTER TABLE "report_notifications" ADD COLUMN "visibility_user_id" text;--> statement-breakpoint
ALTER TABLE "cost_visibility_scopes" ADD CONSTRAINT "cost_visibility_scopes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_access_grants" ADD CONSTRAINT "object_access_grants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cost_visibility_scopes_principal_unique" ON "cost_visibility_scopes" USING btree ("organization_id","principal_kind","principal_id");--> statement-breakpoint
CREATE INDEX "cost_visibility_scopes_org_idx" ON "cost_visibility_scopes" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "object_access_grants_unique" ON "object_access_grants" USING btree ("organization_id","object_type","object_id","principal_kind","principal_id");--> statement-breakpoint
CREATE INDEX "object_access_grants_object_idx" ON "object_access_grants" USING btree ("organization_id","object_type","object_id");