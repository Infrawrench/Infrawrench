CREATE TABLE "log_workspace_queries" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"resources" jsonb NOT NULL,
	"search" text DEFAULT '' NOT NULL,
	"alert_enabled" boolean DEFAULT false NOT NULL,
	"next_eval_at" timestamp,
	"last_eval_at" timestamp,
	"last_match_at" timestamp,
	"last_alerted_at" timestamp,
	"last_eval_error" text,
	"last_match_sample" text,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "msteams_webhooks" ADD COLUMN "log_match_alerts" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "push_preferences" ADD COLUMN "log_match_alerts" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_channels" ADD COLUMN "log_match_alerts" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "log_workspace_queries" ADD CONSTRAINT "log_workspace_queries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_workspace_queries" ADD CONSTRAINT "log_workspace_queries_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "log_workspace_queries_org_idx" ON "log_workspace_queries" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "log_workspace_queries_due_idx" ON "log_workspace_queries" USING btree ("next_eval_at");--> statement-breakpoint
CREATE UNIQUE INDEX "log_workspace_queries_org_name_idx" ON "log_workspace_queries" USING btree ("organization_id","name");