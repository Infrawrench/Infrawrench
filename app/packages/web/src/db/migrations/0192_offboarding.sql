CREATE TABLE "offboarding_items" (
	"id" text PRIMARY KEY NOT NULL,
	"offboarding_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"item_key" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"detail" text,
	"plugin_id" text,
	"provider_name" text,
	"account_id" text,
	"account_name" text,
	"resource_id" text,
	"resource_type_id" text,
	"confidence" text NOT NULL,
	"match_reason" text NOT NULL,
	"match_state" text NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ref" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution" text,
	"last_error" text,
	"note" text,
	"resolved_by_user_id" text,
	"resolved_by_name" text,
	"resolved_at" timestamp,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offboardings" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"subject_user_id" text,
	"subject_name" text,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"source_detail" text,
	"note" text,
	"started_by_user_id" text,
	"started_by_name" text,
	"last_scanned_at" timestamp,
	"scan_truncated" boolean DEFAULT false NOT NULL,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "offboarding_items" ADD CONSTRAINT "offboarding_items_offboarding_id_offboardings_id_fk" FOREIGN KEY ("offboarding_id") REFERENCES "public"."offboardings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offboarding_items" ADD CONSTRAINT "offboarding_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offboardings" ADD CONSTRAINT "offboardings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "offboarding_items_key_unique" ON "offboarding_items" USING btree ("offboarding_id","item_key");--> statement-breakpoint
CREATE INDEX "offboarding_items_org_idx" ON "offboarding_items" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "offboardings_org_idx" ON "offboardings" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "offboardings_org_open_email_unique" ON "offboardings" USING btree ("organization_id","email") WHERE status = 'open';