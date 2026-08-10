CREATE TABLE "resource_leases" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"account_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	"resource_type_id" text NOT NULL,
	"display_name" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"auto_delete" boolean DEFAULT false NOT NULL,
	"note" text,
	"status" text DEFAULT 'active' NOT NULL,
	"first_warning_at" timestamp,
	"final_warning_at" timestamp,
	"next_check_at" timestamp,
	"delete_attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"completed_at" timestamp,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "resource_leases" ADD CONSTRAINT "resource_leases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_leases" ADD CONSTRAINT "resource_leases_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_leases" ADD CONSTRAINT "resource_leases_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "resource_leases_org_idx" ON "resource_leases" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "resource_leases_due_idx" ON "resource_leases" USING btree ("next_check_at");--> statement-breakpoint
CREATE UNIQUE INDEX "resource_leases_org_resource_idx" ON "resource_leases" USING btree ("organization_id","resource_id");