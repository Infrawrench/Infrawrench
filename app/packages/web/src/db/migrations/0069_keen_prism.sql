CREATE TABLE "synthetic_probes" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"method" text DEFAULT 'GET' NOT NULL,
	"interval_seconds" integer DEFAULT 60 NOT NULL,
	"timeout_ms" integer DEFAULT 10000 NOT NULL,
	"failure_threshold" integer DEFAULT 3 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"account_id" text,
	"resource_id" text,
	"plugin_id" text,
	"resource_type_id" text,
	"output_key" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'unknown' NOT NULL,
	"last_probe_at" timestamp,
	"next_probe_at" timestamp,
	"last_status_code" integer,
	"last_latency_ms" integer,
	"last_error" text,
	"last_state_change_at" timestamp,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "synthetic_probes_interval_min" CHECK ("synthetic_probes"."interval_seconds" >= 60),
	CONSTRAINT "synthetic_probes_timeout_positive" CHECK ("synthetic_probes"."timeout_ms" > 0),
	CONSTRAINT "synthetic_probes_threshold_positive" CHECK ("synthetic_probes"."failure_threshold" > 0)
);
--> statement-breakpoint
ALTER TABLE "msteams_webhooks" ADD COLUMN "probe_alerts" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "push_preferences" ADD COLUMN "probe_alerts" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_channels" ADD COLUMN "probe_alerts" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "synthetic_probes" ADD CONSTRAINT "synthetic_probes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthetic_probes" ADD CONSTRAINT "synthetic_probes_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthetic_probes" ADD CONSTRAINT "synthetic_probes_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "synthetic_probes_org_idx" ON "synthetic_probes" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "synthetic_probes_due_idx" ON "synthetic_probes" USING btree ("next_probe_at");