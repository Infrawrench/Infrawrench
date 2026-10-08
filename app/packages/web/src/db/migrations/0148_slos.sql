CREATE TABLE "slos" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"sli_kind" text NOT NULL,
	"probe_id" text,
	"latency_threshold_ms" integer,
	"resource_id" text,
	"metric_key" text,
	"comparator" text,
	"threshold" double precision,
	"target_percent" double precision NOT NULL,
	"window_days" integer DEFAULT 30 NOT NULL,
	"alerts_enabled" boolean DEFAULT true NOT NULL,
	"suggest_freeze" boolean DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_eval_at" timestamp,
	"last_eval_at" timestamp,
	"sli" double precision,
	"good_events" double precision DEFAULT 0 NOT NULL,
	"total_events" double precision DEFAULT 0 NOT NULL,
	"budget_remaining" double precision,
	"burn_rates" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_error" text,
	"burn_alert" text DEFAULT 'none' NOT NULL,
	"burn_alert_changed_at" timestamp,
	"exhausted_at" timestamp,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "slos_target_range" CHECK ("slos"."target_percent" >= 50 AND "slos"."target_percent" < 100),
	CONSTRAINT "slos_window_allowed" CHECK ("slos"."window_days" IN (7, 28, 30))
);
--> statement-breakpoint
ALTER TABLE "slos" ADD CONSTRAINT "slos_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slos" ADD CONSTRAINT "slos_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "slos_org_idx" ON "slos" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "slos_due_idx" ON "slos" USING btree ("next_eval_at");--> statement-breakpoint
CREATE UNIQUE INDEX "slos_org_name_unique" ON "slos" USING btree ("organization_id","name");