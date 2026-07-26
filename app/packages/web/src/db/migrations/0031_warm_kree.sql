CREATE TABLE "workflow_pages" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"key" text NOT NULL,
	"last_paged_at" timestamp DEFAULT now() NOT NULL,
	"last_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "push_preferences" ADD COLUMN "workflow_pages" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_pages" ADD CONSTRAINT "workflow_pages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_pages" ADD CONSTRAINT "workflow_pages_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_pages_workflow_key_unique" ON "workflow_pages" USING btree ("workflow_id","key");--> statement-breakpoint
CREATE INDEX "workflow_pages_org_idx" ON "workflow_pages" USING btree ("organization_id");