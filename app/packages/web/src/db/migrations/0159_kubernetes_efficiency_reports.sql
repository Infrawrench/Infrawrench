CREATE TABLE "kubernetes_efficiency_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"config" jsonb NOT NULL,
	"folder_id" text,
	"created_by_user_id" text,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kubernetes_efficiency_reports" ADD CONSTRAINT "kubernetes_efficiency_reports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kubernetes_efficiency_reports" ADD CONSTRAINT "kubernetes_efficiency_reports_folder_id_cost_report_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."cost_report_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kubernetes_efficiency_reports" ADD CONSTRAINT "kubernetes_efficiency_reports_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kubernetes_efficiency_reports_org_idx" ON "kubernetes_efficiency_reports" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "kubernetes_efficiency_reports_folder_idx" ON "kubernetes_efficiency_reports" USING btree ("organization_id","folder_id");