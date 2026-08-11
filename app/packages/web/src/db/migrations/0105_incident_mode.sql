CREATE TABLE "incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"title" text NOT NULL,
	"severity" text DEFAULT 'sev2' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"summary" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"mitigated_at" timestamp,
	"resolved_at" timestamp,
	"declared_by_user_id" text,
	"resolved_by_user_id" text,
	"affected_resource_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"affected_account_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"issue_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incident_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"incident_id" text NOT NULL,
	"body" text NOT NULL,
	"author_user_id" text,
	"occurred_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incident_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"incident_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"label" text,
	"ref_id" text,
	"ref_secondary" text,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "status_page_notices" (
	"id" text PRIMARY KEY NOT NULL,
	"status_page_id" text NOT NULL,
	"incident_id" text,
	"title" text NOT NULL,
	"body" text,
	"state" text DEFAULT 'investigating' NOT NULL,
	"affected_component_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_declared_by_user_id_users_id_fk" FOREIGN KEY ("declared_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_notes" ADD CONSTRAINT "incident_notes_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_notes" ADD CONSTRAINT "incident_notes_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_artifacts" ADD CONSTRAINT "incident_artifacts_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_page_notices" ADD CONSTRAINT "status_page_notices_status_page_id_status_pages_id_fk" FOREIGN KEY ("status_page_id") REFERENCES "public"."status_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "incidents_org_started_idx" ON "incidents" USING btree ("organization_id","started_at");--> statement-breakpoint
CREATE INDEX "incidents_org_status_idx" ON "incidents" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "incident_notes_incident_idx" ON "incident_notes" USING btree ("incident_id","occurred_at");--> statement-breakpoint
CREATE INDEX "incident_artifacts_incident_idx" ON "incident_artifacts" USING btree ("incident_id");--> statement-breakpoint
CREATE UNIQUE INDEX "incident_artifacts_incident_kind_unique" ON "incident_artifacts" USING btree ("incident_id","kind");--> statement-breakpoint
CREATE INDEX "status_page_notices_page_idx" ON "status_page_notices" USING btree ("status_page_id","started_at");--> statement-breakpoint
CREATE INDEX "status_page_notices_incident_idx" ON "status_page_notices" USING btree ("incident_id");
