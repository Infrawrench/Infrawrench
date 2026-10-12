CREATE TABLE "org_scorecard_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"default_seeded_at" timestamp,
	"next_eval_at" timestamp,
	"last_eval_at" timestamp,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scorecard_history" (
	"scorecard_id" text NOT NULL,
	"service_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"day" date NOT NULL,
	"score" double precision,
	"level" text,
	CONSTRAINT "scorecard_history_scorecard_id_service_id_day_pk" PRIMARY KEY("scorecard_id","service_id","day")
);
--> statement-breakpoint
CREATE TABLE "scorecard_results" (
	"scorecard_id" text NOT NULL,
	"service_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"score" double precision,
	"level" text,
	"check_results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evaluated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "scorecard_results_scorecard_id_service_id_pk" PRIMARY KEY("scorecard_id","service_id")
);
--> statement-breakpoint
CREATE TABLE "scorecards" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"levels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"applicable_tiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"alert_on_level_drop" boolean DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"last_evaluated_at" timestamp,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_links" (
	"service_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"target_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "service_links_service_id_kind_target_id_pk" PRIMARY KEY("service_id","kind","target_id"),
	CONSTRAINT "service_links_kind_allowed" CHECK ("service_links"."kind" IN ('slo', 'runbook'))
);
--> statement-breakpoint
CREATE TABLE "service_members" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"service_id" text NOT NULL,
	"account_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	"resource_type_id" text NOT NULL,
	"resource_name" text NOT NULL,
	"mode" text DEFAULT 'include' NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "service_members_mode_allowed" CHECK ("service_members"."mode" IN ('include', 'exclude'))
);
--> statement-breakpoint
CREATE TABLE "service_owners" (
	"service_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "service_owners_service_id_user_id_pk" PRIMARY KEY("service_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"tier" integer,
	"owner_team" text,
	"links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"on_call_schedule_id" text,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"monthly_budget" double precision,
	"budget_currency" text,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "services_tier_range" CHECK ("services"."tier" IS NULL OR "services"."tier" BETWEEN 1 AND 4)
);
--> statement-breakpoint
ALTER TABLE "org_scorecard_settings" ADD CONSTRAINT "org_scorecard_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scorecard_history" ADD CONSTRAINT "scorecard_history_scorecard_id_scorecards_id_fk" FOREIGN KEY ("scorecard_id") REFERENCES "public"."scorecards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scorecard_history" ADD CONSTRAINT "scorecard_history_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scorecard_history" ADD CONSTRAINT "scorecard_history_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scorecard_results" ADD CONSTRAINT "scorecard_results_scorecard_id_scorecards_id_fk" FOREIGN KEY ("scorecard_id") REFERENCES "public"."scorecards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scorecard_results" ADD CONSTRAINT "scorecard_results_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scorecard_results" ADD CONSTRAINT "scorecard_results_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scorecards" ADD CONSTRAINT "scorecards_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scorecards" ADD CONSTRAINT "scorecards_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_links" ADD CONSTRAINT "service_links_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_links" ADD CONSTRAINT "service_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_members" ADD CONSTRAINT "service_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_members" ADD CONSTRAINT "service_members_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_members" ADD CONSTRAINT "service_members_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_members" ADD CONSTRAINT "service_members_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_owners" ADD CONSTRAINT "service_owners_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_owners" ADD CONSTRAINT "service_owners_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_on_call_schedule_id_on_call_schedules_id_fk" FOREIGN KEY ("on_call_schedule_id") REFERENCES "public"."on_call_schedules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scorecard_history_service_day_idx" ON "scorecard_history" USING btree ("service_id","day");--> statement-breakpoint
CREATE INDEX "scorecard_results_org_idx" ON "scorecard_results" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "scorecard_results_service_idx" ON "scorecard_results" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "scorecards_org_idx" ON "scorecards" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scorecards_org_name_unique" ON "scorecards" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "service_links_org_target_idx" ON "service_links" USING btree ("organization_id","kind","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "service_members_service_resource_unique" ON "service_members" USING btree ("service_id","resource_id");--> statement-breakpoint
CREATE INDEX "service_members_org_resource_idx" ON "service_members" USING btree ("organization_id","resource_id");--> statement-breakpoint
CREATE INDEX "service_members_account_idx" ON "service_members" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "service_owners_user_idx" ON "service_owners" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "services_org_idx" ON "services" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "services_org_slug_unique" ON "services" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "services_org_name_unique" ON "services" USING btree ("organization_id","name");