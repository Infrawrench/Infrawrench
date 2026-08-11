CREATE TABLE "iac_managed_resources" (
	"id" text PRIMARY KEY NOT NULL,
	"state_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"address" text NOT NULL,
	"module" text,
	"mode" text NOT NULL,
	"terraform_type" text NOT NULL,
	"terraform_name" text NOT NULL,
	"index_key" text,
	"provider_name" text,
	"identifiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"redacted_attribute_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "iac_states" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"account_id" text,
	"label" text NOT NULL,
	"format" text NOT NULL,
	"format_version" text NOT NULL,
	"terraform_version" text,
	"serial" integer,
	"lineage" text,
	"resource_count" integer DEFAULT 0 NOT NULL,
	"data_source_count" integer DEFAULT 0 NOT NULL,
	"redacted_attribute_count" integer DEFAULT 0 NOT NULL,
	"parse_warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"uploaded_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "iac_managed_resources" ADD CONSTRAINT "iac_managed_resources_state_id_iac_states_id_fk" FOREIGN KEY ("state_id") REFERENCES "public"."iac_states"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iac_managed_resources" ADD CONSTRAINT "iac_managed_resources_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iac_states" ADD CONSTRAINT "iac_states_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iac_states" ADD CONSTRAINT "iac_states_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iac_states" ADD CONSTRAINT "iac_states_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "iac_managed_resources_state_idx" ON "iac_managed_resources" USING btree ("state_id");--> statement-breakpoint
CREATE INDEX "iac_managed_resources_org_type_idx" ON "iac_managed_resources" USING btree ("organization_id","terraform_type");--> statement-breakpoint
CREATE INDEX "iac_states_org_created_idx" ON "iac_states" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "iac_states_org_account_idx" ON "iac_states" USING btree ("organization_id","account_id");