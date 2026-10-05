CREATE TABLE "org_sso_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"workos_organization_id" text NOT NULL,
	"enforce_sso" boolean DEFAULT false NOT NULL,
	"verified_domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"break_glass_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provisioning_enabled" boolean DEFAULT false NOT NULL,
	"default_role_id" text,
	"auto_add_seats" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"updated_by_user_id" text
);
--> statement-breakpoint
CREATE TABLE "sso_directory_members" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"directory_id" text NOT NULL,
	"directory_user_id" text NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"user_id" text,
	"group_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text NOT NULL,
	"provisioned_by_directory" boolean DEFAULT false NOT NULL,
	"last_synced_at" timestamp DEFAULT now() NOT NULL,
	"deprovisioned_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sso_group_role_mappings" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"directory_group_id" text NOT NULL,
	"group_name" text NOT NULL,
	"role_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workos_webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"organization_id" text,
	"received_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_sso_settings" ADD CONSTRAINT "org_sso_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_sso_settings" ADD CONSTRAINT "org_sso_settings_default_role_id_roles_id_fk" FOREIGN KEY ("default_role_id") REFERENCES "public"."roles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_directory_members" ADD CONSTRAINT "sso_directory_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_directory_members" ADD CONSTRAINT "sso_directory_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_group_role_mappings" ADD CONSTRAINT "sso_group_role_mappings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_group_role_mappings" ADD CONSTRAINT "sso_group_role_mappings_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "org_sso_settings_workos_org_unique" ON "org_sso_settings" USING btree ("workos_organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sso_directory_members_org_dir_user_unique" ON "sso_directory_members" USING btree ("organization_id","directory_user_id");--> statement-breakpoint
CREATE INDEX "sso_directory_members_org_user_idx" ON "sso_directory_members" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sso_group_role_mappings_org_group_unique" ON "sso_group_role_mappings" USING btree ("organization_id","directory_group_id");--> statement-breakpoint
CREATE INDEX "sso_group_role_mappings_org_idx" ON "sso_group_role_mappings" USING btree ("organization_id","position");--> statement-breakpoint
CREATE INDEX "workos_webhook_events_received_idx" ON "workos_webhook_events" USING btree ("received_at");