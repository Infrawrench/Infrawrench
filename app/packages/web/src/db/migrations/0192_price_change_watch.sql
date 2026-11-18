CREATE TABLE "org_price_change_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"min_monthly_impact_cents" integer DEFAULT 1000 NOT NULL,
	"min_percent" double precision DEFAULT 1 NOT NULL,
	"register_expected" boolean DEFAULT true NOT NULL,
	"last_notified_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_change_events" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"change_key" text NOT NULL,
	"plugin_id" text NOT NULL,
	"platform" text NOT NULL,
	"instance_type" text NOT NULL,
	"region" text NOT NULL,
	"selection" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"old_hourly_usd" double precision NOT NULL,
	"new_hourly_usd" double precision NOT NULL,
	"effective_at" timestamp NOT NULL,
	"units" integer NOT NULL,
	"approximate" boolean DEFAULT false NOT NULL,
	"monthly_impact_usd" double precision NOT NULL,
	"resources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"alerted_at" timestamp,
	"suppression_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scenario_model_id" text,
	"detected_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_price_change_settings" ADD CONSTRAINT "org_price_change_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_change_events" ADD CONSTRAINT "price_change_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "price_change_events_org_key_idx" ON "price_change_events" USING btree ("organization_id","change_key");--> statement-breakpoint
CREATE INDEX "price_change_events_org_effective_idx" ON "price_change_events" USING btree ("organization_id","effective_at");