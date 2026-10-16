CREATE TABLE "savings_views" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'open' NOT NULL,
	"filter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sort" jsonb DEFAULT '{"field":"savings","direction":"desc"}'::jsonb NOT NULL,
	"created_by_user_id" text,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "savings_finding_states" ADD COLUMN "gone_at" timestamp;--> statement-breakpoint
ALTER TABLE "savings_finding_states" ADD COLUMN "alert_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "savings_finding_states" ADD COLUMN "status" text DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE "savings_finding_states" ADD COLUMN "status_changed_at" timestamp;--> statement-breakpoint
ALTER TABLE "savings_finding_states" ADD COLUMN "status_changed_by_user_id" text;--> statement-breakpoint
ALTER TABLE "savings_finding_states" ADD COLUMN "status_note" text;--> statement-breakpoint
ALTER TABLE "savings_finding_states" ADD COLUMN "resolution" text;--> statement-breakpoint
ALTER TABLE "savings_finding_states" ADD COLUMN "title" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "savings_finding_states" ADD COLUMN "detail" text;--> statement-breakpoint
ALTER TABLE "savings_finding_states" ADD COLUMN "plugin_id" text;--> statement-breakpoint
ALTER TABLE "savings_finding_states" ADD COLUMN "plugin_name" text;--> statement-breakpoint
ALTER TABLE "savings_finding_states" ADD COLUMN "account_id" text;--> statement-breakpoint
ALTER TABLE "savings_finding_states" ADD COLUMN "account_name" text;--> statement-breakpoint
ALTER TABLE "savings_finding_states" ADD COLUMN "region" text;--> statement-breakpoint
ALTER TABLE "savings_finding_states" ADD COLUMN "resource_id" text;--> statement-breakpoint
ALTER TABLE "savings_finding_states" ADD COLUMN "resource_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "savings_finding_states" ADD COLUMN "resource_type_id" text;--> statement-breakpoint
ALTER TABLE "savings_finding_states" ADD COLUMN "resource_type_name" text;--> statement-breakpoint
ALTER TABLE "savings_finding_states" ADD COLUMN "tags" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "savings_finding_states" ADD COLUMN "monthly_amount" double precision;--> statement-breakpoint
ALTER TABLE "savings_finding_states" ADD COLUMN "currency" text;--> statement-breakpoint
ALTER TABLE "savings_views" ADD CONSTRAINT "savings_views_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "savings_views_org_idx" ON "savings_views" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "savings_views_org_name_unique" ON "savings_views" USING btree ("organization_id","name") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "savings_finding_states_org_status_idx" ON "savings_finding_states" USING btree ("organization_id","status");--> statement-breakpoint
ALTER TABLE "savings_finding_states" ADD CONSTRAINT "savings_finding_states_status_valid" CHECK ("savings_finding_states"."status" IN ('ready', 'in_progress', 'completed', 'archived'));--> statement-breakpoint
ALTER TABLE "savings_finding_states" ADD CONSTRAINT "savings_finding_states_resolution_valid" CHECK ("savings_finding_states"."resolution" IS NULL OR "savings_finding_states"."resolution" IN ('manual', 'resolved'));