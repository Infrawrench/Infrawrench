CREATE TABLE "cost_exports" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"format" text DEFAULT 'csv' NOT NULL,
	"query" jsonb NOT NULL,
	"cadence" text DEFAULT 'daily' NOT NULL,
	"hour" integer DEFAULT 4 NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"restatement_days" integer DEFAULT 7 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"destination_kind" text NOT NULL,
	"destination" jsonb NOT NULL,
	"encrypted_credentials" text,
	"credentials_iv" text,
	"credential_hint" text,
	"last_run_at" timestamp,
	"last_status" text DEFAULT 'pending' NOT NULL,
	"last_error" text,
	"last_object_count" integer,
	"last_row_count" integer,
	"next_run_at" timestamp,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	CONSTRAINT "cost_exports_hour_range" CHECK ("cost_exports"."hour" >= 0 AND "cost_exports"."hour" <= 23),
	CONSTRAINT "cost_exports_restatement_days_range" CHECK ("cost_exports"."restatement_days" >= 0 AND "cost_exports"."restatement_days" <= 90)
);
--> statement-breakpoint
ALTER TABLE "cost_exports" ADD CONSTRAINT "cost_exports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cost_exports_org_idx" ON "cost_exports" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "cost_exports_due_idx" ON "cost_exports" USING btree ("next_run_at");