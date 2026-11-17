CREATE TABLE "account_resource_counts" (
	"organization_id" text NOT NULL,
	"account_id" text NOT NULL,
	"ts" timestamp(3) with time zone NOT NULL,
	"counts_json" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_cost_attributed" (
	"organization_id" text NOT NULL,
	"account_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	"day" date NOT NULL,
	"service" text NOT NULL,
	"region" text NOT NULL,
	"resource_id" text NOT NULL,
	"tags" jsonb NOT NULL,
	"tags_hash" text NOT NULL,
	"currency" text NOT NULL,
	"amount" double precision NOT NULL,
	"usage_amount" double precision NOT NULL,
	"usage_unit" text NOT NULL,
	"ingested_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"charge_type" text DEFAULT 'usage' NOT NULL,
	"amortized_amount" double precision DEFAULT 0 NOT NULL,
	"amortized_reported" smallint DEFAULT 0 NOT NULL,
	"commitment_id" text DEFAULT '' NOT NULL,
	"run_at" timestamp(3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_request_daily" (
	"organization_id" text NOT NULL,
	"source_id" text NOT NULL,
	"day" date NOT NULL,
	"collected_at" timestamp(3) with time zone NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"requests" bigint NOT NULL,
	"input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"cache_read_tokens" bigint NOT NULL,
	"cache_write_tokens" bigint NOT NULL,
	"reasoning_tokens" bigint NOT NULL,
	"reported_cost" double precision NOT NULL,
	"reported_cost_known" smallint NOT NULL,
	"reported_currency" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_daily" (
	"organization_id" text NOT NULL,
	"account_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	"day" date NOT NULL,
	"service" text NOT NULL,
	"region" text NOT NULL,
	"resource_id" text NOT NULL,
	"tags" jsonb NOT NULL,
	"tags_hash" text NOT NULL,
	"currency" text NOT NULL,
	"amount" double precision NOT NULL,
	"usage_amount" double precision NOT NULL,
	"usage_unit" text NOT NULL,
	"ingested_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"charge_type" text DEFAULT 'usage' NOT NULL,
	"amortized_amount" double precision DEFAULT 0 NOT NULL,
	"amortized_reported" smallint DEFAULT 0 NOT NULL,
	"commitment_id" text DEFAULT '' NOT NULL,
	"list_amount" double precision DEFAULT 0 NOT NULL,
	"list_reported" smallint DEFAULT 0 NOT NULL,
	"blended_amount" double precision DEFAULT 0 NOT NULL,
	"blended_reported" smallint DEFAULT 0 NOT NULL,
	CONSTRAINT "cost_daily_pkey" PRIMARY KEY("organization_id","account_id","day","service","region","resource_id","tags_hash","currency")
);
--> statement-breakpoint
CREATE TABLE "dashboard_stats" (
	"organization_id" text NOT NULL,
	"account_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"ts" timestamp(3) with time zone NOT NULL,
	"stats_json" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metric_points_1h" (
	"organization_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"series_label" text NOT NULL,
	"unit" text NOT NULL,
	"ts_hour" timestamp with time zone NOT NULL,
	"value_sum" double precision NOT NULL,
	"value_count" bigint NOT NULL,
	"value_min" double precision NOT NULL,
	"value_max" double precision NOT NULL,
	CONSTRAINT "metric_points_1h_organization_id_resource_id_series_label_ts_hour_pk" PRIMARY KEY("organization_id","resource_id","series_label","ts_hour")
);
--> statement-breakpoint
CREATE TABLE "metric_points_1m" (
	"organization_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"series_label" text NOT NULL,
	"unit" text NOT NULL,
	"ts_minute" timestamp with time zone NOT NULL,
	"value_sum" double precision NOT NULL,
	"value_count" bigint NOT NULL,
	"value_min" double precision NOT NULL,
	"value_max" double precision NOT NULL,
	CONSTRAINT "metric_points_1m_organization_id_resource_id_series_label_ts_minute_pk" PRIMARY KEY("organization_id","resource_id","series_label","ts_minute")
);
--> statement-breakpoint
CREATE TABLE "metric_points_raw" (
	"organization_id" text NOT NULL,
	"account_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	"resource_type_id" text NOT NULL,
	"series_label" text NOT NULL,
	"unit" text NOT NULL,
	"ts" timestamp(3) with time zone NOT NULL,
	"value" double precision NOT NULL,
	CONSTRAINT "metric_points_raw_organization_id_resource_id_series_label_ts_pk" PRIMARY KEY("organization_id","resource_id","series_label","ts")
);
--> statement-breakpoint
CREATE TABLE "network_flow_daily" (
	"organization_id" text NOT NULL,
	"account_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	"day" date NOT NULL,
	"scope" text NOT NULL,
	"direction" text NOT NULL,
	"attribution" text NOT NULL,
	"pair_hash" text NOT NULL,
	"src_ref" text NOT NULL,
	"src_label" text NOT NULL,
	"src_zone" text NOT NULL,
	"src_region" text NOT NULL,
	"src_service" text NOT NULL,
	"src_resource_type_id" text NOT NULL,
	"dst_ref" text NOT NULL,
	"dst_label" text NOT NULL,
	"dst_zone" text NOT NULL,
	"dst_region" text NOT NULL,
	"dst_service" text NOT NULL,
	"dst_resource_type_id" text NOT NULL,
	"bytes" bigint NOT NULL,
	"packets" bigint NOT NULL,
	"currency" text NOT NULL,
	"rate_per_gb" double precision NOT NULL,
	"estimated_cost" double precision NOT NULL,
	"method" text DEFAULT '' NOT NULL,
	"src_network" text DEFAULT '' NOT NULL,
	"dst_network" text DEFAULT '' NOT NULL,
	"ingested_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "network_flow_daily_pkey" PRIMARY KEY("organization_id","account_id","day","scope","direction","attribution","pair_hash")
);
--> statement-breakpoint
CREATE TABLE "poll_outcomes" (
	"organization_id" text NOT NULL,
	"account_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	"ts" timestamp(3) with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"resource_count" integer NOT NULL,
	"succeeded_type_count" integer NOT NULL,
	"failed_type_count" integer NOT NULL,
	"skipped_type_count" integer NOT NULL,
	"first_error" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "account_resource_counts_account_ts_idx" ON "account_resource_counts" USING btree ("organization_id","account_id","ts");--> statement-breakpoint
CREATE INDEX "account_resource_counts_ts_idx" ON "account_resource_counts" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "ai_cost_attributed_org_day_run_idx" ON "ai_cost_attributed" USING btree ("organization_id","day","run_at");--> statement-breakpoint
CREATE INDEX "ai_request_daily_org_day_source_idx" ON "ai_request_daily" USING btree ("organization_id","day","source_id","collected_at");--> statement-breakpoint
CREATE INDEX "cost_daily_org_day_idx" ON "cost_daily" USING btree ("organization_id","day");--> statement-breakpoint
CREATE INDEX "cost_daily_org_resource_idx" ON "cost_daily" USING btree ("organization_id","resource_id");--> statement-breakpoint
CREATE INDEX "cost_daily_tags_idx" ON "cost_daily" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "dashboard_stats_resource_ts_idx" ON "dashboard_stats" USING btree ("organization_id","resource_id","ts");--> statement-breakpoint
CREATE INDEX "dashboard_stats_ts_idx" ON "dashboard_stats" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "metric_points_1h_ts_idx" ON "metric_points_1h" USING btree ("ts_hour");--> statement-breakpoint
CREATE INDEX "metric_points_1m_ts_idx" ON "metric_points_1m" USING btree ("ts_minute");--> statement-breakpoint
CREATE INDEX "metric_points_raw_org_plugin_type_idx" ON "metric_points_raw" USING btree ("organization_id","plugin_id","resource_type_id");--> statement-breakpoint
CREATE INDEX "metric_points_raw_ts_idx" ON "metric_points_raw" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "network_flow_daily_org_day_idx" ON "network_flow_daily" USING btree ("organization_id","day");--> statement-breakpoint
CREATE INDEX "poll_outcomes_account_ts_idx" ON "poll_outcomes" USING btree ("organization_id","account_id","ts");--> statement-breakpoint
CREATE INDEX "poll_outcomes_ts_idx" ON "poll_outcomes" USING btree ("ts");