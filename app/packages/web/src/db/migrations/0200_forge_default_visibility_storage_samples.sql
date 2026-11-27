CREATE TABLE "git_storage_samples" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"hour" timestamp NOT NULL,
	"bytes" bigint NOT NULL,
	"private_bytes" bigint NOT NULL,
	"billable_bytes" bigint NOT NULL,
	"reported_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "git_namespaces" ADD COLUMN "default_visibility" text DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "git_storage_samples" ADD CONSTRAINT "git_storage_samples_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "git_storage_samples_org_hour_idx" ON "git_storage_samples" USING btree ("organization_id","hour");--> statement-breakpoint
CREATE INDEX "git_storage_samples_reported_idx" ON "git_storage_samples" USING btree ("reported_at","hour");