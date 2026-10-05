CREATE TABLE "kubernetes_network_settings" (
	"account_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"billed_query" text,
	"updated_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kubernetes_network_settings" ADD CONSTRAINT "kubernetes_network_settings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kubernetes_network_settings" ADD CONSTRAINT "kubernetes_network_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kubernetes_network_settings" ADD CONSTRAINT "kubernetes_network_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kubernetes_network_settings_org_idx" ON "kubernetes_network_settings" USING btree ("organization_id");