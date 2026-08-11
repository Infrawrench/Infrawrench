CREATE TABLE "backup_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"resource_type_ids" text DEFAULT '' NOT NULL,
	"tag_key" text,
	"tag_value" text,
	"max_rpo_hours" integer,
	"min_retention_days" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "backup_policies_demands_something" CHECK ("backup_policies"."max_rpo_hours" IS NOT NULL OR "backup_policies"."min_retention_days" IS NOT NULL),
	CONSTRAINT "backup_policies_tag_value_needs_key" CHECK ("backup_policies"."tag_value" IS NULL OR "backup_policies"."tag_key" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "backup_policies" ADD CONSTRAINT "backup_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_policies" ADD CONSTRAINT "backup_policies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backup_policies_org_idx" ON "backup_policies" USING btree ("organization_id");
