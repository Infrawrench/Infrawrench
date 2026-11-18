CREATE TABLE "game_day_alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"game_day_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"at" timestamp DEFAULT now() NOT NULL,
	"trigger" text NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"related" boolean NOT NULL,
	"paged" boolean NOT NULL,
	"unrouted" boolean NOT NULL,
	"delivery_ids" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "game_day_targets" (
	"id" text PRIMARY KEY NOT NULL,
	"game_day_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"resource_id" text NOT NULL,
	"account_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	"resource_type_id" text NOT NULL,
	"display_name" text NOT NULL,
	"action_id" text NOT NULL,
	"action_label" text NOT NULL,
	"undo_label" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"undo_state" jsonb,
	"state_before" text,
	"injected_at" timestamp,
	"reverted_at" timestamp,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "game_days" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"service_id" text,
	"status" text DEFAULT 'planned' NOT NULL,
	"end_reason" text,
	"starts_at" timestamp NOT NULL,
	"duration_minutes" integer NOT NULL,
	"recovery_timeout_minutes" integer DEFAULT 30 NOT NULL,
	"freeze_during_run" boolean DEFAULT false NOT NULL,
	"freeze_id" text,
	"watched_probe_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"watched_slo_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"related_resource_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"armed_at" timestamp,
	"armed_by_user_id" text,
	"injected_at" timestamp,
	"ends_at" timestamp,
	"end_requested_at" timestamp,
	"ended_by_user_id" text,
	"undone_at" timestamp,
	"recovered_at" timestamp,
	"completed_at" timestamp,
	"last_error" text,
	"signals" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"next_check_at" timestamp,
	"claimed_until" timestamp,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "game_day_alerts" ADD CONSTRAINT "game_day_alerts_game_day_id_game_days_id_fk" FOREIGN KEY ("game_day_id") REFERENCES "public"."game_days"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_day_alerts" ADD CONSTRAINT "game_day_alerts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_day_targets" ADD CONSTRAINT "game_day_targets_game_day_id_game_days_id_fk" FOREIGN KEY ("game_day_id") REFERENCES "public"."game_days"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_day_targets" ADD CONSTRAINT "game_day_targets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_days" ADD CONSTRAINT "game_days_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_days" ADD CONSTRAINT "game_days_armed_by_user_id_users_id_fk" FOREIGN KEY ("armed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_days" ADD CONSTRAINT "game_days_ended_by_user_id_users_id_fk" FOREIGN KEY ("ended_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_days" ADD CONSTRAINT "game_days_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "game_day_alerts_game_day_idx" ON "game_day_alerts" USING btree ("game_day_id","at");--> statement-breakpoint
CREATE INDEX "game_day_targets_game_day_idx" ON "game_day_targets" USING btree ("game_day_id","position");--> statement-breakpoint
CREATE INDEX "game_days_org_idx" ON "game_days" USING btree ("organization_id","starts_at");--> statement-breakpoint
CREATE INDEX "game_days_due_idx" ON "game_days" USING btree ("next_check_at");--> statement-breakpoint
CREATE INDEX "game_days_org_status_idx" ON "game_days" USING btree ("organization_id","status");