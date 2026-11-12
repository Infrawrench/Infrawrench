CREATE TABLE "ci_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"installation_id" integer NOT NULL,
	"repo_full_name" text NOT NULL,
	"default_branch" text NOT NULL,
	"sha" text,
	"pipelines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"refresh_after" timestamp DEFAULT now() NOT NULL,
	"refreshed_at" timestamp,
	"read_ok_at" timestamp,
	"fired_through" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ci_runs" ADD COLUMN "pipeline_file" text;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD COLUMN "pipeline_text" text;--> statement-breakpoint
ALTER TABLE "ci_schedules" ADD CONSTRAINT "ci_schedules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ci_schedules_repo_idx" ON "ci_schedules" USING btree ("installation_id","repo_full_name");--> statement-breakpoint
CREATE INDEX "ci_schedules_org_idx" ON "ci_schedules" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ci_schedules_refresh_idx" ON "ci_schedules" USING btree ("refresh_after");