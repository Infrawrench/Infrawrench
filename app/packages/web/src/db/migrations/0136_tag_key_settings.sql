CREATE TABLE "org_tag_key_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"hidden_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"preferred_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_tag_key_settings" ADD CONSTRAINT "org_tag_key_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;