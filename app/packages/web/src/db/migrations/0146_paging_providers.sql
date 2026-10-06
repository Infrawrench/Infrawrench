CREATE TABLE "paging_provider_events" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"account_id" text NOT NULL,
	"target_id" text NOT NULL,
	"dedup_key" text NOT NULL,
	"lifecycle_key" text,
	"alert_delivery_id" text,
	"trigger" text NOT NULL,
	"title" text NOT NULL,
	"state" text DEFAULT 'triggered' NOT NULL,
	"pending_action" text,
	"payload" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp,
	"last_error" text,
	"external_url" text,
	"sent_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paging_provider_incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"account_id" text NOT NULL,
	"external_id" text NOT NULL,
	"reference" text,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"status_label" text,
	"urgency" text,
	"url" text,
	"service_name" text,
	"assignees" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dedup_key" text,
	"external_created_at" timestamp NOT NULL,
	"external_updated_at" timestamp,
	"resolved_at" timestamp,
	"synced_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paging_provider_settings" (
	"account_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"inbound_enabled" boolean DEFAULT false NOT NULL,
	"webhook_token" text NOT NULL,
	"webhook_id" text,
	"encrypted_webhook_secret" text,
	"webhook_secret_iv" text,
	"last_synced_at" timestamp,
	"last_sync_error" text,
	"next_sync_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "paging_provider_events" ADD CONSTRAINT "paging_provider_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paging_provider_events" ADD CONSTRAINT "paging_provider_events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paging_provider_incidents" ADD CONSTRAINT "paging_provider_incidents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paging_provider_incidents" ADD CONSTRAINT "paging_provider_incidents_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paging_provider_settings" ADD CONSTRAINT "paging_provider_settings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paging_provider_settings" ADD CONSTRAINT "paging_provider_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "paging_provider_events_target_dedup_unique" ON "paging_provider_events" USING btree ("account_id","target_id","dedup_key");--> statement-breakpoint
CREATE INDEX "paging_provider_events_org_lifecycle_idx" ON "paging_provider_events" USING btree ("organization_id","lifecycle_key");--> statement-breakpoint
CREATE INDEX "paging_provider_events_delivery_idx" ON "paging_provider_events" USING btree ("alert_delivery_id");--> statement-breakpoint
CREATE INDEX "paging_provider_events_due_idx" ON "paging_provider_events" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE INDEX "paging_provider_events_account_dedup_idx" ON "paging_provider_events" USING btree ("account_id","dedup_key");--> statement-breakpoint
CREATE UNIQUE INDEX "paging_provider_incidents_account_external_unique" ON "paging_provider_incidents" USING btree ("account_id","external_id");--> statement-breakpoint
CREATE INDEX "paging_provider_incidents_org_status_idx" ON "paging_provider_incidents" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "paging_provider_settings_webhook_token_unique" ON "paging_provider_settings" USING btree ("webhook_token");--> statement-breakpoint
CREATE INDEX "paging_provider_settings_org_idx" ON "paging_provider_settings" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "paging_provider_settings_next_sync_idx" ON "paging_provider_settings" USING btree ("next_sync_at");