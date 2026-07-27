CREATE TABLE "external_pages" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"source" text NOT NULL,
	"key" text NOT NULL,
	"last_paged_at" timestamp DEFAULT now() NOT NULL,
	"last_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "external_pages" ADD CONSTRAINT "external_pages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "external_pages_org_source_key_unique" ON "external_pages" USING btree ("organization_id","source","key");--> statement-breakpoint
CREATE INDEX "external_pages_org_idx" ON "external_pages" USING btree ("organization_id");