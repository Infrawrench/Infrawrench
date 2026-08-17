CREATE TABLE "runbooks" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resource_type_ids" text DEFAULT '' NOT NULL,
	"tag_key" text,
	"tag_value" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "runbooks_tag_value_needs_key" CHECK ("runbooks"."tag_value" IS NULL OR "runbooks"."tag_key" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "runbook_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"runbook_id" text NOT NULL,
	"runbook_name" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"incident_id" text,
	"started_by_user_id" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"summary" text,
	CONSTRAINT "runbook_runs_status_known" CHECK ("runbook_runs"."status" IN ('running', 'completed', 'abandoned'))
);
--> statement-breakpoint
CREATE TABLE "runbook_run_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"step_id" text NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"note" text,
	"workflow_run_id" text,
	"actor_user_id" text,
	"updated_at" timestamp,
	CONSTRAINT "runbook_run_steps_kind_known" CHECK ("runbook_run_steps"."kind" IN ('manual', 'workflow', 'link')),
	CONSTRAINT "runbook_run_steps_status_known" CHECK ("runbook_run_steps"."status" IN ('pending', 'done', 'skipped', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "runbooks" ADD CONSTRAINT "runbooks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runbooks" ADD CONSTRAINT "runbooks_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runbook_runs" ADD CONSTRAINT "runbook_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runbook_runs" ADD CONSTRAINT "runbook_runs_runbook_id_runbooks_id_fk" FOREIGN KEY ("runbook_id") REFERENCES "public"."runbooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runbook_runs" ADD CONSTRAINT "runbook_runs_started_by_user_id_users_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runbook_run_steps" ADD CONSTRAINT "runbook_run_steps_run_id_runbook_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runbook_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runbook_run_steps" ADD CONSTRAINT "runbook_run_steps_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runbooks_org_idx" ON "runbooks" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runbooks_org_name_unique" ON "runbooks" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "runbook_runs_org_idx" ON "runbook_runs" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "runbook_runs_runbook_idx" ON "runbook_runs" USING btree ("runbook_id","started_at");--> statement-breakpoint
CREATE INDEX "runbook_runs_incident_idx" ON "runbook_runs" USING btree ("incident_id");--> statement-breakpoint
CREATE INDEX "runbook_run_steps_run_idx" ON "runbook_run_steps" USING btree ("run_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "runbook_run_steps_run_step_unique" ON "runbook_run_steps" USING btree ("run_id","step_id");
