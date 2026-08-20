CREATE TABLE "on_call_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"timezone" text NOT NULL,
	"rotation_days" integer DEFAULT 7 NOT NULL,
	"handoff_time" text DEFAULT '09:00' NOT NULL,
	"start_date" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "on_call_schedules_rotation_days_range" CHECK ("on_call_schedules"."rotation_days" BETWEEN 1 AND 31),
	CONSTRAINT "on_call_schedules_start_date_shape" CHECK ("on_call_schedules"."start_date" ~ '^\d{4}-\d{2}-\d{2}$'),
	CONSTRAINT "on_call_schedules_handoff_shape" CHECK ("on_call_schedules"."handoff_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
);
--> statement-breakpoint
CREATE TABLE "on_call_participants" (
	"id" text PRIMARY KEY NOT NULL,
	"schedule_id" text NOT NULL,
	"user_id" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "on_call_overrides" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"schedule_id" text NOT NULL,
	"user_id" text NOT NULL,
	"starts_at" timestamp NOT NULL,
	"ends_at" timestamp NOT NULL,
	"reason" text,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "on_call_overrides_window_ordered" CHECK ("on_call_overrides"."ends_at" > "on_call_overrides"."starts_at")
);
--> statement-breakpoint
ALTER TABLE "on_call_schedules" ADD CONSTRAINT "on_call_schedules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "on_call_schedules" ADD CONSTRAINT "on_call_schedules_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "on_call_participants" ADD CONSTRAINT "on_call_participants_schedule_id_on_call_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."on_call_schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "on_call_participants" ADD CONSTRAINT "on_call_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "on_call_overrides" ADD CONSTRAINT "on_call_overrides_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "on_call_overrides" ADD CONSTRAINT "on_call_overrides_schedule_id_on_call_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."on_call_schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "on_call_overrides" ADD CONSTRAINT "on_call_overrides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "on_call_overrides" ADD CONSTRAINT "on_call_overrides_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "on_call_schedules_org_idx" ON "on_call_schedules" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "on_call_schedules_org_name_unique" ON "on_call_schedules" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "on_call_participants_schedule_idx" ON "on_call_participants" USING btree ("schedule_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "on_call_participants_schedule_user_unique" ON "on_call_participants" USING btree ("schedule_id","user_id");--> statement-breakpoint
CREATE INDEX "on_call_overrides_schedule_window_idx" ON "on_call_overrides" USING btree ("schedule_id","starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "on_call_overrides_org_idx" ON "on_call_overrides" USING btree ("organization_id");
