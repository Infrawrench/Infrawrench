CREATE TABLE "agent_link_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"label" text NOT NULL,
	"requested_scopes" jsonb NOT NULL,
	"hashed_device_code" text NOT NULL,
	"hashed_user_code" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"organization_id" text,
	"approved_scopes" jsonb,
	"link_id" text,
	"decided_by_user_id" text,
	"last_polled_at" timestamp,
	"expires_at" timestamp NOT NULL,
	"created_from_ip" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_links" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"platform" text NOT NULL,
	"label" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"approved_by_user_id" text,
	"hashed_credential" text,
	"credential_prefix" text,
	"last_seen_at" timestamp,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_auth_registrations" ADD COLUMN "link_id" text;--> statement-breakpoint
ALTER TABLE "agent_auth_registrations" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "agent_auth_registrations" ADD COLUMN "scopes" jsonb;--> statement-breakpoint
ALTER TABLE "agent_auth_registrations" ADD COLUMN "providers" jsonb;--> statement-breakpoint
ALTER TABLE "agent_link_requests" ADD CONSTRAINT "agent_link_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_link_requests" ADD CONSTRAINT "agent_link_requests_link_id_agent_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."agent_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_link_requests" ADD CONSTRAINT "agent_link_requests_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_links" ADD CONSTRAINT "agent_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_links" ADD CONSTRAINT "agent_links_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_link_requests_device_code_unique" ON "agent_link_requests" USING btree ("hashed_device_code");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_link_requests_user_code_unique" ON "agent_link_requests" USING btree ("hashed_user_code");--> statement-breakpoint
CREATE INDEX "agent_link_requests_ip_created_idx" ON "agent_link_requests" USING btree ("created_from_ip","created_at");--> statement-breakpoint
CREATE INDEX "agent_links_org_idx" ON "agent_links" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_links_credential_unique" ON "agent_links" USING btree ("hashed_credential");--> statement-breakpoint
ALTER TABLE "agent_auth_registrations" ADD CONSTRAINT "agent_auth_registrations_link_id_agent_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."agent_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_auth_registrations_link_external_live_unique" ON "agent_auth_registrations" USING btree ("link_id","external_id") WHERE "agent_auth_registrations"."revoked_at" is null and "agent_auth_registrations"."link_id" is not null;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "agent_link_id" text;--> statement-breakpoint
CREATE INDEX "agent_link_requests_created_idx" ON "agent_link_requests" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "agent_link_requests_expires_idx" ON "agent_link_requests" USING btree ("expires_at");