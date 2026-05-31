CREATE TABLE "dashboard_workflow_pins" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"dashboard_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"grid_x" integer DEFAULT 0 NOT NULL,
	"sync_version" integer DEFAULT 0 NOT NULL,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dashboard_workflow_pins" ADD CONSTRAINT "dashboard_workflow_pins_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_workflow_pins" ADD CONSTRAINT "dashboard_workflow_pins_dashboard_id_dashboards_id_fk" FOREIGN KEY ("dashboard_id") REFERENCES "public"."dashboards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_workflow_pins" ADD CONSTRAINT "dashboard_workflow_pins_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dashboard_workflow_pin_unique" ON "dashboard_workflow_pins" USING btree ("dashboard_id","workflow_id");--> statement-breakpoint
CREATE INDEX "dashboard_workflow_pin_dashboard_idx" ON "dashboard_workflow_pins" USING btree ("dashboard_id");