CREATE TABLE "resource_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"account_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	"resource_type_id" text NOT NULL,
	"display_name" text NOT NULL,
	"change_kind" text NOT NULL,
	"diff" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "resource_changes" ADD CONSTRAINT "resource_changes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_changes" ADD CONSTRAINT "resource_changes_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "resource_changes_org_created_idx" ON "resource_changes" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "resource_changes_resource_created_idx" ON "resource_changes" USING btree ("resource_id","created_at");--> statement-breakpoint
CREATE INDEX "resource_changes_org_account_idx" ON "resource_changes" USING btree ("organization_id","account_id");