CREATE TABLE "cost_scenario_models" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"currency" text DEFAULT 'USD' NOT NULL,
	"adjustments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_user_id" text,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "budgets" ADD COLUMN "scenario_model_id" text;--> statement-breakpoint
ALTER TABLE "cost_scenario_models" ADD CONSTRAINT "cost_scenario_models_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_scenario_models" ADD CONSTRAINT "cost_scenario_models_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cost_scenario_models_org_idx" ON "cost_scenario_models" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cost_scenario_models_org_name_unique" ON "cost_scenario_models" USING btree ("organization_id","name") WHERE deleted_at IS NULL;