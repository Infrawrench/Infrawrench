CREATE TABLE "org_product_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"disabled_products" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "products" jsonb;--> statement-breakpoint
ALTER TABLE "org_product_settings" ADD CONSTRAINT "org_product_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;