CREATE TABLE "resource_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"account_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	"resource_type_id" text NOT NULL,
	"days_of_week" jsonb NOT NULL,
	"stop_time" text NOT NULL,
	"start_time" text NOT NULL,
	"timezone" text NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"next_transition_at" timestamp,
	"next_transition_action" text,
	"last_transition_key" text,
	"last_run_at" timestamp,
	"last_run_action" text,
	"last_run_status" text,
	"last_run_error" text,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "resource_changes" ADD COLUMN "origin" text;--> statement-breakpoint
ALTER TABLE "resource_schedules" ADD CONSTRAINT "resource_schedules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_schedules" ADD CONSTRAINT "resource_schedules_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_schedules" ADD CONSTRAINT "resource_schedules_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "resource_schedules_org_idx" ON "resource_schedules" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "resource_schedules_due_idx" ON "resource_schedules" USING btree ("next_transition_at");--> statement-breakpoint
CREATE UNIQUE INDEX "resource_schedules_org_resource_idx" ON "resource_schedules" USING btree ("organization_id","resource_id");