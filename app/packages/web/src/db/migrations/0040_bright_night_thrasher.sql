CREATE TABLE "deployment_triggers" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"repo" text NOT NULL,
	"branch" text NOT NULL,
	"env" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_sha" text,
	"last_run_at" timestamp with time zone,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deployment_triggers" ADD CONSTRAINT "deployment_triggers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deployment_triggers_org_idx" ON "deployment_triggers" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "deployment_triggers_enabled_idx" ON "deployment_triggers" USING btree ("enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "deployment_triggers_unique" ON "deployment_triggers" USING btree ("organization_id","repo","branch","env");