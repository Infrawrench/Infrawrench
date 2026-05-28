CREATE TABLE "account_sync_failures" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"account_id" text NOT NULL,
	"resource_type_id" text NOT NULL,
	"failed_at" timestamp DEFAULT now() NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "paging_incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"account_id" text NOT NULL,
	"resource_type_id" text NOT NULL,
	"opened_at" timestamp DEFAULT now() NOT NULL,
	"closed_at" timestamp,
	"paged_at" timestamp,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "twilio_recipients" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"display_name" text NOT NULL,
	"phone_number" text NOT NULL,
	"sms" boolean DEFAULT true NOT NULL,
	"voice" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "twilio_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"encrypted_account_sid" text,
	"account_sid_iv" text,
	"encrypted_auth_token" text,
	"auth_token_iv" text,
	"from_number" text,
	"failure_threshold" integer DEFAULT 3 NOT NULL,
	"window_minutes" integer DEFAULT 10 NOT NULL,
	"cooldown_minutes" integer DEFAULT 60 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_sync_failures" ADD CONSTRAINT "account_sync_failures_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_sync_failures" ADD CONSTRAINT "account_sync_failures_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paging_incidents" ADD CONSTRAINT "paging_incidents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paging_incidents" ADD CONSTRAINT "paging_incidents_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "twilio_recipients" ADD CONSTRAINT "twilio_recipients_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "twilio_settings" ADD CONSTRAINT "twilio_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_sync_failures_org_account_type_idx" ON "account_sync_failures" USING btree ("organization_id","account_id","resource_type_id");--> statement-breakpoint
CREATE INDEX "account_sync_failures_failed_at_idx" ON "account_sync_failures" USING btree ("failed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "paging_incidents_open_unique" ON "paging_incidents" USING btree ("account_id","resource_type_id") WHERE closed_at IS NULL;--> statement-breakpoint
CREATE INDEX "paging_incidents_org_idx" ON "paging_incidents" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "twilio_recipients_org_idx" ON "twilio_recipients" USING btree ("organization_id");