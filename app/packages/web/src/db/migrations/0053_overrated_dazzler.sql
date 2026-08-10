CREATE TABLE "digest_email_recipients" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_digest_settings" ADD COLUMN "timezone" text DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
ALTER TABLE "org_digest_settings" ADD COLUMN "send_day" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "org_digest_settings" ADD COLUMN "send_hour" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "org_digest_settings" ADD COLUMN "narrative_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "org_digest_settings" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "org_digest_settings" ADD COLUMN "last_attempt_at" timestamp;--> statement-breakpoint
ALTER TABLE "org_digest_settings" ADD COLUMN "last_status" text;--> statement-breakpoint
ALTER TABLE "org_digest_settings" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "org_digest_settings" ADD COLUMN "next_attempt_at" timestamp;--> statement-breakpoint
ALTER TABLE "digest_email_recipients" ADD CONSTRAINT "digest_email_recipients_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "digest_email_recipients_org_idx" ON "digest_email_recipients" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "digest_email_recipients_org_email_unique" ON "digest_email_recipients" USING btree ("organization_id","email");