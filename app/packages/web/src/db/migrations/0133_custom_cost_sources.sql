CREATE TABLE "custom_cost_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"default_currency" text,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_cost_uploads" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"source_id" text NOT NULL,
	"file_name" text,
	"format" text NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'uploading' NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"totals" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"uploaded_by_user_id" text,
	"via" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "custom_cost_sources" ADD CONSTRAINT "custom_cost_sources_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_cost_sources" ADD CONSTRAINT "custom_cost_sources_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_cost_uploads" ADD CONSTRAINT "custom_cost_uploads_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_cost_uploads" ADD CONSTRAINT "custom_cost_uploads_source_id_custom_cost_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."custom_cost_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_cost_uploads" ADD CONSTRAINT "custom_cost_uploads_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "custom_cost_sources_org_name_idx" ON "custom_cost_sources" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "custom_cost_uploads_source_idx" ON "custom_cost_uploads" USING btree ("source_id","created_at");