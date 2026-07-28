CREATE TABLE "deployment_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"env" text NOT NULL,
	"repo" text,
	"branch" text,
	"git_sha" text,
	"image" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"origin" text DEFAULT 'web' NOT NULL,
	"stage" text,
	"logs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"plan_json" jsonb,
	"dockerfile" text,
	"notes" text,
	"error" jsonb,
	"created_by_user_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer
);
--> statement-breakpoint
ALTER TABLE "deployment_runs" ADD CONSTRAINT "deployment_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deployment_runs_org_idx" ON "deployment_runs" USING btree ("organization_id","started_at");--> statement-breakpoint
CREATE INDEX "deployment_runs_env_idx" ON "deployment_runs" USING btree ("organization_id","env");