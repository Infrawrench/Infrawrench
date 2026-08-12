CREATE TABLE "environment_instance_members" (
	"id" text PRIMARY KEY NOT NULL,
	"instance_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"member_key" text NOT NULL,
	"plugin_id" text NOT NULL,
	"resource_type_id" text NOT NULL,
	"account_id" text NOT NULL,
	"resource_id" text,
	"external_id" text,
	"display_name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"lease_id" text,
	"next_repair_at" timestamp,
	"repair_attempts" integer DEFAULT 0 NOT NULL,
	"repair_error" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "environment_instances" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"template_id" text,
	"template_name" text NOT NULL,
	"name" text NOT NULL,
	"name_prefix" text NOT NULL,
	"parameters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'creating' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"note" text,
	"error" text,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "environment_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"max_ttl_hours" integer NOT NULL,
	"default_ttl_hours" integer NOT NULL,
	"updated_by_user_id" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "environment_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"parameters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"members" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "environment_instance_members" ADD CONSTRAINT "environment_instance_members_instance_id_environment_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."environment_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_instance_members" ADD CONSTRAINT "environment_instance_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_instance_members" ADD CONSTRAINT "environment_instance_members_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_instances" ADD CONSTRAINT "environment_instances_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_instances" ADD CONSTRAINT "environment_instances_template_id_environment_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."environment_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_instances" ADD CONSTRAINT "environment_instances_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_settings" ADD CONSTRAINT "environment_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_settings" ADD CONSTRAINT "environment_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_templates" ADD CONSTRAINT "environment_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_templates" ADD CONSTRAINT "environment_templates_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "environment_instance_members_instance_idx" ON "environment_instance_members" USING btree ("instance_id");--> statement-breakpoint
CREATE INDEX "environment_instance_members_org_idx" ON "environment_instance_members" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "environment_instance_members_resource_idx" ON "environment_instance_members" USING btree ("resource_id");--> statement-breakpoint
CREATE INDEX "environment_instance_members_repair_due_idx" ON "environment_instance_members" USING btree ("next_repair_at");--> statement-breakpoint
CREATE INDEX "environment_instances_org_idx" ON "environment_instances" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "environment_instances_template_idx" ON "environment_instances" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "environment_instances_expires_idx" ON "environment_instances" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "environment_templates_org_idx" ON "environment_templates" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "environment_templates_org_name_idx" ON "environment_templates" USING btree ("organization_id","name");