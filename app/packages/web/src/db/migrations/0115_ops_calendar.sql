CREATE TABLE "calendar_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text,
	"name" text NOT NULL,
	"hashed_token" text NOT NULL,
	"prefix" text NOT NULL,
	"kinds" text DEFAULT '' NOT NULL,
	"last_accessed_at" timestamp,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calendar_subscriptions" ADD CONSTRAINT "calendar_subscriptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_subscriptions" ADD CONSTRAINT "calendar_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_subscriptions_token_unique" ON "calendar_subscriptions" USING btree ("hashed_token");--> statement-breakpoint
CREATE INDEX "calendar_subscriptions_org_idx" ON "calendar_subscriptions" USING btree ("organization_id");
