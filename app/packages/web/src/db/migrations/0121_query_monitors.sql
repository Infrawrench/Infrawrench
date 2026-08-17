CREATE TABLE "query_monitors" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"account_id" text NOT NULL,
	"resource_id" text,
	"resource_type_id" text,
	"name" text NOT NULL,
	"description" text,
	"sql" text NOT NULL,
	"mode" text DEFAULT 'scalar' NOT NULL,
	"operator" text DEFAULT 'gt' NOT NULL,
	"threshold" double precision NOT NULL,
	"interval_minutes" integer DEFAULT 15 NOT NULL,
	"consecutive_breaches" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp DEFAULT now() NOT NULL,
	"last_run_at" timestamp,
	"state" text DEFAULT 'unknown' NOT NULL,
	"last_value" double precision,
	"last_error" text,
	"breach_streak" integer DEFAULT 0 NOT NULL,
	"last_alerted_at" timestamp,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "query_monitors_mode_known" CHECK ("query_monitors"."mode" IN ('scalar', 'rowCount')),
	CONSTRAINT "query_monitors_operator_known" CHECK ("query_monitors"."operator" IN ('gt', 'gte', 'lt', 'lte', 'eq', 'neq')),
	CONSTRAINT "query_monitors_state_known" CHECK ("query_monitors"."state" IN ('ok', 'breaching', 'unknown')),
	CONSTRAINT "query_monitors_interval_range" CHECK ("query_monitors"."interval_minutes" BETWEEN 5 AND 10080),
	CONSTRAINT "query_monitors_streak_range" CHECK ("query_monitors"."consecutive_breaches" BETWEEN 1 AND 10),
	CONSTRAINT "query_monitors_resource_scope_paired" CHECK (("resource_id" IS NULL) = ("resource_type_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "query_monitors" ADD CONSTRAINT "query_monitors_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "query_monitors" ADD CONSTRAINT "query_monitors_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "query_monitors" ADD CONSTRAINT "query_monitors_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "query_monitors_org_idx" ON "query_monitors" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "query_monitors_due_idx" ON "query_monitors" USING btree ("next_run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "query_monitors_org_name_unique" ON "query_monitors" USING btree ("organization_id","name");
