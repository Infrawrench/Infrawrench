CREATE TABLE "resource_capacity_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"account_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"capacity_key" text NOT NULL,
	"used" double precision NOT NULL,
	"capacity_limit" double precision NOT NULL,
	"observed_at" timestamp NOT NULL,
	"bucket" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_quota_settings" ADD COLUMN "runway_days" integer DEFAULT 14 NOT NULL;--> statement-breakpoint
ALTER TABLE "org_quota_settings" ADD COLUMN "allowance_threshold" double precision DEFAULT 0.8 NOT NULL;--> statement-breakpoint
ALTER TABLE "resource_capacity_snapshots" ADD CONSTRAINT "resource_capacity_snapshots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_capacity_snapshots" ADD CONSTRAINT "resource_capacity_snapshots_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "resource_capacity_snapshots_bucket_unique" ON "resource_capacity_snapshots" USING btree ("resource_id","capacity_key","bucket");--> statement-breakpoint
CREATE INDEX "resource_capacity_snapshots_org_observed_idx" ON "resource_capacity_snapshots" USING btree ("organization_id","observed_at");