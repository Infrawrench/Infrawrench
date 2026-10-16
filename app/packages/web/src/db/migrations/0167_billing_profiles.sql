CREATE TABLE "billing_logos" (
	"organization_id" text NOT NULL,
	"id" text NOT NULL,
	"data_url" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "billing_logos_organization_id_id_pk" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "billing_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"address" text,
	"tax_id" text,
	"po_number" text,
	"to_emails" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc_emails" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"currency" text,
	"payment_terms_days" integer,
	"number_prefix" text DEFAULT 'INV' NOT NULL,
	"number_includes_year" boolean DEFAULT true NOT NULL,
	"number_start" integer DEFAULT 1 NOT NULL,
	"tax_rates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bank" jsonb,
	"footer" text,
	"logo" text,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "managed_accounts" ADD COLUMN "billing_profile_id" text;--> statement-breakpoint
ALTER TABLE "managed_invoices" ADD COLUMN "billing" jsonb;--> statement-breakpoint
ALTER TABLE "billing_logos" ADD CONSTRAINT "billing_logos_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_profiles" ADD CONSTRAINT "billing_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_profiles" ADD CONSTRAINT "billing_profiles_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_profiles_org_idx" ON "billing_profiles" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_profiles_org_name_unique" ON "billing_profiles" USING btree ("organization_id","name");--> statement-breakpoint
ALTER TABLE "managed_accounts" ADD CONSTRAINT "managed_accounts_billing_profile_id_billing_profiles_id_fk" FOREIGN KEY ("billing_profile_id") REFERENCES "public"."billing_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Every org that already bills customers gets one "Default" profile with the
-- numbering it has been using all along (INV-YYYY-NNNN, sequence from 1, no
-- tax, no terms, no currency override), and every live customer is assigned
-- to it. Nothing about the next invoice changes: each customer's own contact
-- email, address and currency still apply because the profile leaves them
-- blank. What changes is that there is now one place to add the org's tax
-- line, terms and bank details for all of them at once. Idempotent: an org
-- that already has a profile is skipped.
INSERT INTO "billing_profiles" ("id", "organization_id", "name")
SELECT gen_random_uuid()::text, ma."organization_id", 'Default'
FROM (SELECT DISTINCT "organization_id" FROM "managed_accounts" WHERE "deleted_at" IS NULL) ma
WHERE NOT EXISTS (
  SELECT 1 FROM "billing_profiles" bp WHERE bp."organization_id" = ma."organization_id"
);--> statement-breakpoint
UPDATE "managed_accounts" ma
SET "billing_profile_id" = bp."id"
FROM "billing_profiles" bp
WHERE bp."organization_id" = ma."organization_id"
  AND bp."name" = 'Default'
  AND ma."deleted_at" IS NULL
  AND ma."billing_profile_id" IS NULL;