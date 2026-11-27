CREATE TABLE "git_terraform_scans" (
	"id" text PRIMARY KEY NOT NULL,
	"repository_id" text NOT NULL,
	"tree_oid" text NOT NULL,
	"scanner_version" integer NOT NULL,
	"commit_oid" text NOT NULL,
	"summary" jsonb NOT NULL,
	"pricing_inputs" jsonb NOT NULL,
	"estimates" jsonb,
	"pricing_status" text DEFAULT 'pending' NOT NULL,
	"priced_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "git_terraform_scans_pricing_status_valid" CHECK ("git_terraform_scans"."pricing_status" IN ('pending', 'priced', 'unavailable'))
);
--> statement-breakpoint
ALTER TABLE "git_terraform_scans" ADD CONSTRAINT "git_terraform_scans_repository_id_git_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."git_repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "git_terraform_scans_tree_idx" ON "git_terraform_scans" USING btree ("repository_id","tree_oid","scanner_version");--> statement-breakpoint
CREATE INDEX "git_terraform_scans_pending_idx" ON "git_terraform_scans" USING btree ("pricing_status","created_at");