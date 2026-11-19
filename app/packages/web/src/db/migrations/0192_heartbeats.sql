CREATE TABLE "heartbeat_pings" (
	"id" text PRIMARY KEY NOT NULL,
	"heartbeat_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"duration_ms" integer,
	"method" text NOT NULL,
	"user_agent" text,
	"body" text
);
--> statement-breakpoint
CREATE TABLE "heartbeats" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"schedule_kind" text NOT NULL,
	"cron_expression" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"interval_minutes" integer,
	"grace_minutes" integer DEFAULT 10 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"ping_token" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"down_reason" text,
	"last_ping_at" timestamp,
	"last_start_at" timestamp,
	"last_fail_at" timestamp,
	"last_duration_ms" integer,
	"next_expected_at" timestamp,
	"deadline_at" timestamp,
	"last_state_change_at" timestamp,
	"ping_window_start" timestamp,
	"ping_window_count" integer DEFAULT 0 NOT NULL,
	"account_id" text,
	"resource_id" text,
	"plugin_id" text,
	"resource_type_id" text,
	"field_key" text,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "heartbeats_grace_range" CHECK ("heartbeats"."grace_minutes" >= 1 AND "heartbeats"."grace_minutes" <= 10080),
	CONSTRAINT "heartbeats_schedule_shape" CHECK (("heartbeats"."schedule_kind" = 'cron' AND "heartbeats"."cron_expression" IS NOT NULL) OR ("heartbeats"."schedule_kind" = 'interval' AND "heartbeats"."interval_minutes" >= 1))
);
--> statement-breakpoint
ALTER TABLE "heartbeat_pings" ADD CONSTRAINT "heartbeat_pings_heartbeat_id_heartbeats_id_fk" FOREIGN KEY ("heartbeat_id") REFERENCES "public"."heartbeats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_pings" ADD CONSTRAINT "heartbeat_pings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeats" ADD CONSTRAINT "heartbeats_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeats" ADD CONSTRAINT "heartbeats_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeats" ADD CONSTRAINT "heartbeats_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "heartbeat_pings_heartbeat_idx" ON "heartbeat_pings" USING btree ("heartbeat_id","received_at");--> statement-breakpoint
CREATE INDEX "heartbeat_pings_received_idx" ON "heartbeat_pings" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "heartbeats_org_idx" ON "heartbeats" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "heartbeats_ping_token_unique" ON "heartbeats" USING btree ("ping_token");--> statement-breakpoint
CREATE INDEX "heartbeats_deadline_idx" ON "heartbeats" USING btree ("deadline_at");--> statement-breakpoint
CREATE INDEX "heartbeats_resource_idx" ON "heartbeats" USING btree ("organization_id","resource_id");