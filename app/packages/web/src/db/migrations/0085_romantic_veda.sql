CREATE TABLE "cost_report_folders" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"parent_folder_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cost_report_folders" ADD CONSTRAINT "cost_report_folders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cost_report_folders" ADD CONSTRAINT "cost_report_folders_parent_folder_id_cost_report_folders_id_fk" FOREIGN KEY ("parent_folder_id") REFERENCES "public"."cost_report_folders"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "cost_report_folders_org_idx" ON "cost_report_folders" USING btree ("organization_id");
--> statement-breakpoint
-- "folder_id" predates this table: it was a reserved, round-tripped column, so any
-- non-null value already stored points at nothing. Null them before the FK exists.
UPDATE "cost_reports" SET "folder_id" = NULL WHERE "folder_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "cost_reports" ADD CONSTRAINT "cost_reports_folder_id_cost_report_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."cost_report_folders"("id") ON DELETE set null ON UPDATE no action;
