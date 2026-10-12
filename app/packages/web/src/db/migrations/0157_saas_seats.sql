CREATE TABLE "account_seat_polls" (
	"account_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"last_polled_at" timestamp,
	"next_poll_at" timestamp,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "account_seats" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"account_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	"member_id" text NOT NULL,
	"seat_key" text DEFAULT '' NOT NULL,
	"name" text,
	"email" text,
	"login" text,
	"product" text NOT NULL,
	"category" text NOT NULL,
	"seat_type" text NOT NULL,
	"monthly_price" double precision,
	"currency" text,
	"price_source" text,
	"price_note" text,
	"activity_basis" text NOT NULL,
	"last_active_at" timestamp,
	"activity_window_days" integer,
	"activity_source" text DEFAULT '' NOT NULL,
	"assigned_at" timestamp,
	"pending_removal_on" timestamp,
	"removable" boolean DEFAULT false NOT NULL,
	"removal_note" text,
	"downgrade" jsonb,
	"context" jsonb,
	"resource_type_id" text,
	"external_id" text,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_seat_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"inactive_days" integer DEFAULT 30 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_seat_polls" ADD CONSTRAINT "account_seat_polls_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_seat_polls" ADD CONSTRAINT "account_seat_polls_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_seats" ADD CONSTRAINT "account_seats_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_seats" ADD CONSTRAINT "account_seats_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_seat_settings" ADD CONSTRAINT "org_seat_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_seat_polls_due_idx" ON "account_seat_polls" USING btree ("next_poll_at");--> statement-breakpoint
CREATE INDEX "account_seat_polls_org_idx" ON "account_seat_polls" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_seats_account_member_unique" ON "account_seats" USING btree ("account_id","member_id","seat_key");--> statement-breakpoint
CREATE INDEX "account_seats_org_idx" ON "account_seats" USING btree ("organization_id");