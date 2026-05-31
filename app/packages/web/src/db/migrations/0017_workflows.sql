CREATE TABLE "workflow_metrics" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"type" text DEFAULT 'number' NOT NULL,
	"unit" text,
	"value" jsonb,
	"sync_version" integer DEFAULT 0 NOT NULL,
	"deleted_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"trigger_source" text DEFAULT 'manual' NOT NULL,
	"logs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"output" jsonb,
	"error" jsonb,
	"started_at" timestamp,
	"finished_at" timestamp,
	"duration_ms" integer,
	"sync_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"source" text DEFAULT '' NOT NULL,
	"trigger" jsonb DEFAULT '{"kind":"manual"}'::jsonb NOT NULL,
	"metric_defs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"webhook_token" text,
	"next_run_at" timestamp,
	"last_run_at" timestamp,
	"created_by_user_id" text,
	"sync_version" integer DEFAULT 0 NOT NULL,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_metrics" ADD CONSTRAINT "workflow_metrics_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_metrics" ADD CONSTRAINT "workflow_metrics_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_metrics_workflow_key_idx" ON "workflow_metrics" USING btree ("workflow_id","key");--> statement-breakpoint
CREATE INDEX "workflow_runs_workflow_idx" ON "workflow_runs" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "workflow_runs_org_idx" ON "workflow_runs" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "workflows_org_idx" ON "workflows" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "workflows_due_idx" ON "workflows" USING btree ("next_run_at");--> statement-breakpoint
CREATE INDEX "workflows_webhook_idx" ON "workflows" USING btree ("webhook_token");