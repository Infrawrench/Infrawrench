CREATE TABLE "migration_estimates" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"source" jsonb NOT NULL,
	"target_plugin_id" text NOT NULL,
	"target_region" text,
	"overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "migration_estimates" ADD CONSTRAINT "migration_estimates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_estimates" ADD CONSTRAINT "migration_estimates_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "migration_estimates_org_idx" ON "migration_estimates" USING btree ("organization_id","updated_at");