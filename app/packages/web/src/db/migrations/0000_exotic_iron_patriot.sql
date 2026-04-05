CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	"display_name" text NOT NULL,
	"encrypted_credentials" text NOT NULL,
	"credentials_iv" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "associations" (
	"id" text PRIMARY KEY NOT NULL,
	"consumer_resource_id" text NOT NULL,
	"consumer_field_key" text NOT NULL,
	"provider_resource_id" text NOT NULL,
	"provider_output_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dashboard_pins" (
	"id" text PRIMARY KEY NOT NULL,
	"dashboard_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"grid_x" integer DEFAULT 0 NOT NULL,
	"grid_y" integer DEFAULT 0 NOT NULL,
	"grid_w" integer DEFAULT 1 NOT NULL,
	"grid_h" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dashboards" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_installations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	"package_name" text NOT NULL,
	"version" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"installed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resources" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	"resource_type_id" text NOT NULL,
	"account_id" text NOT NULL,
	"display_name" text NOT NULL,
	"external_id" text,
	"fields_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"outputs_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"parent_resource_id" text,
	"last_synced_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secret_field_states" (
	"id" text PRIMARY KEY NOT NULL,
	"resource_id" text NOT NULL,
	"field_key" text NOT NULL,
	"resolution_kind" text NOT NULL,
	"encrypted_value" text,
	"value_iv" text,
	"source_plugin_id" text,
	"source_resource_type_id" text,
	"source_resource_id" text,
	"source_account_id" text,
	"source_output_key" text,
	"cached_encrypted_value" text,
	"cached_value_iv" text,
	"cached_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "associations" ADD CONSTRAINT "associations_consumer_resource_id_resources_id_fk" FOREIGN KEY ("consumer_resource_id") REFERENCES "public"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "associations" ADD CONSTRAINT "associations_provider_resource_id_resources_id_fk" FOREIGN KEY ("provider_resource_id") REFERENCES "public"."resources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_pins" ADD CONSTRAINT "dashboard_pins_dashboard_id_dashboards_id_fk" FOREIGN KEY ("dashboard_id") REFERENCES "public"."dashboards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_pins" ADD CONSTRAINT "dashboard_pins_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_installations" ADD CONSTRAINT "plugin_installations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_field_states" ADD CONSTRAINT "secret_field_states_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_org_plugin_idx" ON "accounts" USING btree ("organization_id","plugin_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assoc_consumer_unique" ON "associations" USING btree ("consumer_resource_id","consumer_field_key");--> statement-breakpoint
CREATE INDEX "assoc_consumer_idx" ON "associations" USING btree ("consumer_resource_id");--> statement-breakpoint
CREATE INDEX "assoc_provider_idx" ON "associations" USING btree ("provider_resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dashboard_pin_unique" ON "dashboard_pins" USING btree ("dashboard_id","resource_id");--> statement-breakpoint
CREATE INDEX "dashboard_pin_dashboard_idx" ON "dashboard_pins" USING btree ("dashboard_id");--> statement-breakpoint
CREATE INDEX "dashboards_org_idx" ON "dashboards" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_install_org_plugin_unique" ON "plugin_installations" USING btree ("organization_id","plugin_id");--> statement-breakpoint
CREATE INDEX "plugin_install_org_idx" ON "plugin_installations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "resources_org_plugin_type_idx" ON "resources" USING btree ("organization_id","plugin_id","resource_type_id");--> statement-breakpoint
CREATE INDEX "resources_account_idx" ON "resources" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "resources_external_idx" ON "resources" USING btree ("plugin_id","external_id");--> statement-breakpoint
CREATE INDEX "resources_parent_idx" ON "resources" USING btree ("parent_resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "secret_field_resource_field_unique" ON "secret_field_states" USING btree ("resource_id","field_key");--> statement-breakpoint
CREATE INDEX "secret_field_resource_idx" ON "secret_field_states" USING btree ("resource_id");--> statement-breakpoint
CREATE INDEX "users_org_idx" ON "users" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");