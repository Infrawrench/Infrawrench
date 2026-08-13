CREATE TABLE "workflow_secrets" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"encrypted_value" text,
	"encrypted_value_iv" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_secret_assignments" (
	"workflow_id" text NOT NULL,
	"secret_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_secrets" ADD CONSTRAINT "workflow_secrets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_secret_assignments" ADD CONSTRAINT "workflow_secret_assignments_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_secret_assignments" ADD CONSTRAINT "workflow_secret_assignments_secret_id_workflow_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."workflow_secrets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_secrets_org_name_unique" ON "workflow_secrets" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "workflow_secrets_org_idx" ON "workflow_secrets" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_secret_assignments_unique" ON "workflow_secret_assignments" USING btree ("workflow_id","secret_id");--> statement-breakpoint
CREATE INDEX "workflow_secret_assignments_workflow_idx" ON "workflow_secret_assignments" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "workflow_secret_assignments_secret_idx" ON "workflow_secret_assignments" USING btree ("secret_id");
