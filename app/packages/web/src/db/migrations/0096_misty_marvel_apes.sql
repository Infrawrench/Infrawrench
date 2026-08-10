CREATE TABLE "cost_billing_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"match" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"adjustment" jsonb NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "budgets" ADD COLUMN "use_adjusted_spend" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_billing_rules" ADD CONSTRAINT "cost_billing_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_billing_rules" ADD CONSTRAINT "cost_billing_rules_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cost_billing_rules_org_idx" ON "cost_billing_rules" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cost_billing_rules_org_name_unique" ON "cost_billing_rules" USING btree ("organization_id","name");