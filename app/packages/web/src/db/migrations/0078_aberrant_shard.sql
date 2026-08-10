CREATE TABLE "resource_ownership" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"account_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	"resource_type_id" text NOT NULL,
	"resource_name" text NOT NULL,
	"owner_user_id" text,
	"owner_label" text,
	"purpose" text,
	"ticket_url" text,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "status_page_components" (
	"id" text PRIMARY KEY NOT NULL,
	"status_page_id" text NOT NULL,
	"probe_id" text NOT NULL,
	"label" text,
	"group_name" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "status_pages" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"published" boolean DEFAULT false NOT NULL,
	"show_history" boolean DEFAULT true NOT NULL,
	"show_uptime" boolean DEFAULT true NOT NULL,
	"support_url" text,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "resource_ownership" ADD CONSTRAINT "resource_ownership_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_ownership" ADD CONSTRAINT "resource_ownership_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_ownership" ADD CONSTRAINT "resource_ownership_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_ownership" ADD CONSTRAINT "resource_ownership_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_page_components" ADD CONSTRAINT "status_page_components_status_page_id_status_pages_id_fk" FOREIGN KEY ("status_page_id") REFERENCES "public"."status_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_page_components" ADD CONSTRAINT "status_page_components_probe_id_synthetic_probes_id_fk" FOREIGN KEY ("probe_id") REFERENCES "public"."synthetic_probes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_pages" ADD CONSTRAINT "status_pages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_pages" ADD CONSTRAINT "status_pages_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "resource_ownership_org_resource_unique" ON "resource_ownership" USING btree ("organization_id","resource_id");--> statement-breakpoint
CREATE INDEX "resource_ownership_org_idx" ON "resource_ownership" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "resource_ownership_owner_idx" ON "resource_ownership" USING btree ("organization_id","owner_user_id");--> statement-breakpoint
CREATE INDEX "resource_ownership_account_idx" ON "resource_ownership" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "status_page_components_page_idx" ON "status_page_components" USING btree ("status_page_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "status_page_components_page_probe_unique" ON "status_page_components" USING btree ("status_page_id","probe_id");--> statement-breakpoint
CREATE INDEX "status_pages_org_idx" ON "status_pages" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "status_pages_slug_unique" ON "status_pages" USING btree ("slug");