CREATE TABLE "account_network_flow_polls" (
	"account_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"last_polled_at" timestamp,
	"next_poll_at" timestamp,
	"collected_through" date,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_error_help_url" text,
	"last_sources" jsonb,
	"last_query_bytes_scanned" integer
);
--> statement-breakpoint
CREATE TABLE "org_network_flow_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"initial_lookback_days" integer DEFAULT 7 NOT NULL,
	"updated_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_network_flow_polls" ADD CONSTRAINT "account_network_flow_polls_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_network_flow_polls" ADD CONSTRAINT "account_network_flow_polls_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_network_flow_settings" ADD CONSTRAINT "org_network_flow_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_network_flow_settings" ADD CONSTRAINT "org_network_flow_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_network_flow_polls_due_idx" ON "account_network_flow_polls" USING btree ("next_poll_at");--> statement-breakpoint
CREATE INDEX "account_network_flow_polls_org_idx" ON "account_network_flow_polls" USING btree ("organization_id");