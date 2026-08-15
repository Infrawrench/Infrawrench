CREATE TABLE "agent_auth_registrations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"claimed_by_user_id" text,
	"claimed_at" timestamp,
	"kind" text DEFAULT 'anonymous' NOT NULL,
	"label" text,
	"hashed_credential" text,
	"credential_prefix" text,
	"hashed_claim_code" text,
	"claim_code_expires_at" timestamp,
	"created_from_ip" text,
	"last_seen_at" timestamp,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "trial_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "claimed_at" timestamp;--> statement-breakpoint
ALTER TABLE "agent_auth_registrations" ADD CONSTRAINT "agent_auth_registrations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_auth_registrations" ADD CONSTRAINT "agent_auth_registrations_claimed_by_user_id_users_id_fk" FOREIGN KEY ("claimed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_auth_registrations_org_idx" ON "agent_auth_registrations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "agent_auth_registrations_claimed_by_idx" ON "agent_auth_registrations" USING btree ("claimed_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_auth_registrations_credential_unique" ON "agent_auth_registrations" USING btree ("hashed_credential");--> statement-breakpoint
CREATE INDEX "agent_auth_registrations_ip_created_idx" ON "agent_auth_registrations" USING btree ("created_from_ip","created_at");--> statement-breakpoint
-- The reaper's only query: unclaimed trials whose clock has run out. Partial,
-- because the rows it must find are a vanishing fraction of the table and every
-- other org has NULL here forever.
CREATE INDEX "organizations_trial_expiry_idx" ON "organizations" USING btree ("trial_expires_at") WHERE "trial_expires_at" IS NOT NULL;
