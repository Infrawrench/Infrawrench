CREATE TABLE "cost_annotations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"cost_report_id" text,
	"start_date" date NOT NULL,
	"end_date" date,
	"text" text NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cost_annotations" ADD CONSTRAINT "cost_annotations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_annotations" ADD CONSTRAINT "cost_annotations_cost_report_id_cost_reports_id_fk" FOREIGN KEY ("cost_report_id") REFERENCES "public"."cost_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_annotations" ADD CONSTRAINT "cost_annotations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cost_annotations_org_date_idx" ON "cost_annotations" USING btree ("organization_id","start_date");--> statement-breakpoint
CREATE INDEX "cost_annotations_report_idx" ON "cost_annotations" USING btree ("organization_id","cost_report_id");