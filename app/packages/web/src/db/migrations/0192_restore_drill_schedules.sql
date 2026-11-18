CREATE TABLE "restore_drill_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"schedule_id" text,
	"account_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"resource_type_id" text NOT NULL,
	"trigger" text NOT NULL,
	"state" text NOT NULL,
	"outcome" text,
	"restore_point" text NOT NULL,
	"point_in_time_at" timestamp,
	"verify_sql" text,
	"verify_mode" text NOT NULL,
	"verify_operator" text NOT NULL,
	"verify_threshold" double precision NOT NULL,
	"copy_name" text NOT NULL,
	"copy_ref" text,
	"restored_from" text,
	"restore_point_at" timestamp,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"deadline_at" timestamp NOT NULL,
	"ready_at" timestamp,
	"finished_at" timestamp,
	"restore_seconds" integer,
	"verify_value" double precision,
	"detail" text,
	"cleanup_state" text DEFAULT 'none' NOT NULL,
	"cleanup_error" text,
	"cleanup_attempts" integer DEFAULT 0 NOT NULL,
	"cleanup_alerted" boolean DEFAULT false NOT NULL,
	"restore_drill_id" text,
	"next_step_at" timestamp DEFAULT now() NOT NULL,
	"lease_until" timestamp,
	"created_by_user_id" text
);
--> statement-breakpoint
CREATE TABLE "restore_drill_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"account_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"resource_type_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	"interval_days" integer NOT NULL,
	"restore_point" text NOT NULL,
	"point_in_time_hours_ago" integer,
	"verify_sql" text,
	"verify_mode" text DEFAULT 'rowCount' NOT NULL,
	"verify_operator" text DEFAULT 'gt' NOT NULL,
	"verify_threshold" double precision DEFAULT 0 NOT NULL,
	"time_limit_minutes" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp DEFAULT now() NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "restore_drills" ADD COLUMN "rpo_minutes" integer;--> statement-breakpoint
ALTER TABLE "restore_drills" ADD COLUMN "run_id" text;--> statement-breakpoint
ALTER TABLE "restore_drill_runs" ADD CONSTRAINT "restore_drill_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restore_drill_runs" ADD CONSTRAINT "restore_drill_runs_schedule_id_restore_drill_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."restore_drill_schedules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restore_drill_runs" ADD CONSTRAINT "restore_drill_runs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restore_drill_schedules" ADD CONSTRAINT "restore_drill_schedules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restore_drill_schedules" ADD CONSTRAINT "restore_drill_schedules_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restore_drill_schedules" ADD CONSTRAINT "restore_drill_schedules_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "restore_drill_runs_org_schedule_idx" ON "restore_drill_runs" USING btree ("organization_id","schedule_id","started_at");--> statement-breakpoint
CREATE INDEX "restore_drill_runs_active_idx" ON "restore_drill_runs" USING btree ("state","cleanup_state","next_step_at");--> statement-breakpoint
CREATE INDEX "restore_drill_schedules_org_idx" ON "restore_drill_schedules" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "restore_drill_schedules_due_idx" ON "restore_drill_schedules" USING btree ("enabled","next_run_at");