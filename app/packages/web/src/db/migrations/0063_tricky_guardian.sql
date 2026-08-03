CREATE TABLE "ssh_snippets" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"command" text NOT NULL,
	"description" text,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ssh_snippets" ADD CONSTRAINT "ssh_snippets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ssh_snippets" ADD CONSTRAINT "ssh_snippets_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ssh_snippets_org_idx" ON "ssh_snippets" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ssh_snippets_org_name_unique" ON "ssh_snippets" USING btree ("organization_id","name");