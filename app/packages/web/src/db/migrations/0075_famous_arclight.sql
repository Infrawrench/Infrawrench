CREATE TABLE "access_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"user_name" text,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reason" text NOT NULL,
	"duration_minutes" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"decided_at" timestamp,
	"decided_by_user_id" text,
	"decided_by_name" text,
	"decision_note" text,
	"granted_at" timestamp,
	"grant_expires_at" timestamp,
	"revoked_at" timestamp,
	"revoked_by_user_id" text,
	"revoked_by_name" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_requests_org_status_idx" ON "access_requests" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "access_requests_org_user_status_idx" ON "access_requests" USING btree ("organization_id","user_id","status");--> statement-breakpoint
CREATE INDEX "access_requests_org_created_idx" ON "access_requests" USING btree ("organization_id","created_at");