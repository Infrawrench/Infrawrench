CREATE TABLE "ai_attribution_days" (
	"organization_id" text NOT NULL,
	"day" date NOT NULL,
	"run_at" timestamp,
	"sources" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"providers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"collections" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "ai_attribution_days_organization_id_day_pk" PRIMARY KEY("organization_id","day")
);
--> statement-breakpoint
CREATE TABLE "ai_attribution_dimensions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"metadata_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_request_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"plugin_id" text,
	"account_id" text,
	"source_kind_id" text NOT NULL,
	"location" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"lookback_days" integer DEFAULT 7 NOT NULL,
	"base_url" text,
	"encrypted_api_key" text,
	"api_key_iv" text,
	"collected_through" date,
	"last_run_at" timestamp,
	"next_run_at" timestamp,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_error_help_url" text,
	"observed_metadata_keys" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_query_bytes_scanned" integer,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_attribution_days" ADD CONSTRAINT "ai_attribution_days_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_attribution_dimensions" ADD CONSTRAINT "ai_attribution_dimensions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_request_sources" ADD CONSTRAINT "ai_request_sources_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_request_sources" ADD CONSTRAINT "ai_request_sources_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_request_sources" ADD CONSTRAINT "ai_request_sources_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_attribution_dimensions_org_key_idx" ON "ai_attribution_dimensions" USING btree ("organization_id","key");--> statement-breakpoint
CREATE INDEX "ai_request_sources_org_idx" ON "ai_request_sources" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ai_request_sources_due_idx" ON "ai_request_sources" USING btree ("next_run_at");