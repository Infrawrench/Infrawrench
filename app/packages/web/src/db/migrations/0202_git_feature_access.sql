CREATE TABLE "git_feature_access" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"enabled_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "git_feature_access" ADD CONSTRAINT "git_feature_access_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;