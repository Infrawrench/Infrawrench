CREATE TABLE "saved_cost_filters" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"filters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_user_id" text,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "budgets" ADD COLUMN "saved_filter_id" text;--> statement-breakpoint
ALTER TABLE "saved_cost_filters" ADD CONSTRAINT "saved_cost_filters_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_cost_filters" ADD CONSTRAINT "saved_cost_filters_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "saved_cost_filters_org_idx" ON "saved_cost_filters" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "saved_cost_filters_org_name_unique" ON "saved_cost_filters" USING btree ("organization_id","name") WHERE deleted_at IS NULL;
