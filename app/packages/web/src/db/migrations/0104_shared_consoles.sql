CREATE TABLE "shared_consoles" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"live_console_id" text NOT NULL,
	"routing_key" text NOT NULL,
	"owner_user_id" text,
	"owner_name" text,
	"account_id" text,
	"resource_id" text,
	"host" text NOT NULL,
	"port" integer DEFAULT 22 NOT NULL,
	"username" text NOT NULL,
	"recording_id" text,
	"invite_token_hash" text,
	"invite_token_prefix" text,
	"invite_expires_at" timestamp,
	"invite_consumed_at" timestamp,
	"allow_handover" boolean DEFAULT true NOT NULL,
	"pty_cols" integer DEFAULT 80 NOT NULL,
	"pty_rows" integer DEFAULT 24 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"revoked_by_user_id" text,
	"revoked_at" timestamp,
	"ended_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shared_console_participants" (
	"id" text PRIMARY KEY NOT NULL,
	"shared_console_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"user_name" text,
	"role" text DEFAULT 'observer' NOT NULL,
	"status" text DEFAULT 'joined' NOT NULL,
	"driver_requested_at" timestamp,
	"viewport_cols" integer,
	"viewport_rows" integer,
	"joined_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"left_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "shared_consoles" ADD CONSTRAINT "shared_consoles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_consoles" ADD CONSTRAINT "shared_consoles_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_consoles" ADD CONSTRAINT "shared_consoles_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_console_participants" ADD CONSTRAINT "shared_console_participants_shared_console_id_shared_consoles_id_fk" FOREIGN KEY ("shared_console_id") REFERENCES "public"."shared_consoles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_console_participants" ADD CONSTRAINT "shared_console_participants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_console_participants" ADD CONSTRAINT "shared_console_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shared_consoles_live_console_unique" ON "shared_consoles" USING btree ("live_console_id");--> statement-breakpoint
CREATE INDEX "shared_consoles_org_status_idx" ON "shared_consoles" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "shared_consoles_org_created_idx" ON "shared_consoles" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shared_console_participants_console_user_unique" ON "shared_console_participants" USING btree ("shared_console_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shared_console_participants_one_driver_idx" ON "shared_console_participants" USING btree ("shared_console_id") WHERE "shared_console_participants"."role" = 'driver' AND "shared_console_participants"."status" = 'joined';--> statement-breakpoint
CREATE INDEX "shared_console_participants_console_idx" ON "shared_console_participants" USING btree ("shared_console_id");--> statement-breakpoint
CREATE INDEX "shared_console_participants_org_user_idx" ON "shared_console_participants" USING btree ("organization_id","user_id");--> statement-breakpoint
ALTER TABLE "ssh_session_recordings" ADD COLUMN "shared_console_id" text;--> statement-breakpoint
ALTER TABLE "ssh_session_recordings" ADD COLUMN "participants" jsonb;
