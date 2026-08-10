CREATE TABLE "business_metric_values" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"metric_id" text NOT NULL,
	"day" date NOT NULL,
	"value" double precision NOT NULL,
	"source" text DEFAULT 'api' NOT NULL,
	"updated_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "business_metrics" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"unit" text NOT NULL,
	"description" text,
	"kind" text DEFAULT 'count' NOT NULL,
	"currency" text,
	"cost_scope" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"saved_filter_id" text,
	"created_by_user_id" text,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "business_metrics_currency_matches_kind" CHECK (("business_metrics"."kind" = 'currency') = ("business_metrics"."currency" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "business_metric_values" ADD CONSTRAINT "business_metric_values_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_metric_values" ADD CONSTRAINT "business_metric_values_metric_id_business_metrics_id_fk" FOREIGN KEY ("metric_id") REFERENCES "public"."business_metrics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_metric_values" ADD CONSTRAINT "business_metric_values_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_metrics" ADD CONSTRAINT "business_metrics_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_metrics" ADD CONSTRAINT "business_metrics_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "business_metric_values_metric_day_unique" ON "business_metric_values" USING btree ("metric_id","day");--> statement-breakpoint
CREATE INDEX "business_metric_values_metric_day_idx" ON "business_metric_values" USING btree ("metric_id","day");--> statement-breakpoint
CREATE INDEX "business_metric_values_org_idx" ON "business_metric_values" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "business_metrics_org_idx" ON "business_metrics" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "business_metrics_org_key_unique" ON "business_metrics" USING btree ("organization_id","key") WHERE deleted_at IS NULL;
