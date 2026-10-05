CREATE TABLE "org_savings_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"horizon_months" integer DEFAULT 12 NOT NULL,
	"shortfall_threshold_percent" integer DEFAULT 70 NOT NULL,
	"baseline_window_days" integer DEFAULT 14 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "savings_events" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"title" text NOT NULL,
	"note" text,
	"occurred_on" date NOT NULL,
	"ended_on" date,
	"account_id" text,
	"plugin_id" text,
	"resource_type_id" text,
	"resource_id" text,
	"external_id" text,
	"resource_name" text,
	"tags" jsonb,
	"cost_centre_id" text,
	"projected_monthly_amount" double precision,
	"currency" text,
	"baseline_daily_estimate" double precision,
	"post_daily_estimate" double precision,
	"off_fraction" double precision,
	"schedule_id" text,
	"horizon_months" integer,
	"dedupe_key" text,
	"cost_annotation_id" text,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_savings_settings" ADD CONSTRAINT "org_savings_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_events" ADD CONSTRAINT "savings_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_events" ADD CONSTRAINT "savings_events_cost_centre_id_cost_centres_id_fk" FOREIGN KEY ("cost_centre_id") REFERENCES "public"."cost_centres"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_events" ADD CONSTRAINT "savings_events_cost_annotation_id_cost_annotations_id_fk" FOREIGN KEY ("cost_annotation_id") REFERENCES "public"."cost_annotations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_events" ADD CONSTRAINT "savings_events_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "savings_events_org_occurred_idx" ON "savings_events" USING btree ("organization_id","occurred_on");--> statement-breakpoint
CREATE UNIQUE INDEX "savings_events_org_dedupe_unique" ON "savings_events" USING btree ("organization_id","dedupe_key") WHERE "savings_events"."dedupe_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "savings_events_org_schedule_idx" ON "savings_events" USING btree ("organization_id","schedule_id");