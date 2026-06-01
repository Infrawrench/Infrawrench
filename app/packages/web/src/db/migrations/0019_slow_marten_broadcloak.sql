CREATE TABLE "github_installations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"installation_id" integer NOT NULL,
	"account_login" text,
	"account_type" text,
	"created_by_user_id" text,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "git_last_sha" text;--> statement-breakpoint
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_installations_org_idx" ON "github_installations" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "github_installations_installation_idx" ON "github_installations" USING btree ("installation_id");