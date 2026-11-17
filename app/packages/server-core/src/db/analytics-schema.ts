/**
 * The analytics tables: metrics, poll outcomes, daily cost, network flow and AI
 * attribution. They lived in a separate ClickHouse cluster until the volumes
 * made that a second database to run for a few megabytes of data; the module
 * that reads and writes them is `../analytics/`.
 *
 * ## Property names are the column names
 *
 * Drizzle's convention is a camelCase property mapped onto a snake_case column.
 * These tables deliberately do not follow it: the property name *is* the column
 * name, so `cost_daily`'s `organization_id` is `organization_id` in TypeScript
 * too. The row shapes are a wire contract that leaves this process: the cost
 * ingest API accepts them, `analytics/cost-reconcile.ts` compares stored rows
 * against about-to-be-written ones field by field, and the export writes them
 * into customer buckets, and every one of those is specified in the database's
 * spelling. A camelCase mirror would put a translation layer between two things
 * that are the same thing.
 *
 * ## Identity and replacement
 *
 * `cost_daily` and `network_flow_daily` have a primary key over their full
 * dimension tuple, and every write is an upsert that keeps the newer
 * `ingested_at` (`analytics/cost-writers.ts`). Re-fetching a day replaces the
 * row in place. **The keys are frozen**: changing one re-keys history. A new
 * dimension that has to keep cost rows distinct is folded into `tags_hash`
 * instead (see `hashTags`), and `pair_hash` plays the same role for flows.
 *
 * `ai_request_daily` and `ai_cost_attributed` are append-only per collection
 * (`collected_at`) or run (`run_at`); readers take the latest per day, which
 * makes a re-collection atomic from a reader's point of view.
 *
 * ## Metric rollups
 *
 * `metric_points_raw` is keyed on (org, resource, series, ts), so a re-fetched
 * overlapping window inserts nothing twice. `insertMetricPoints` folds exactly
 * the rows it newly inserted into the minute and hour rollups in the same
 * statement, as running sum/count/min/max: an average is `value_sum /
 * value_count`, so rollups merge by addition and are never recomputed.
 *
 * ## Retention
 *
 * There is no TTL in Postgres. `analytics/retention.ts` deletes expired rows
 * (the `analytics-retention` poller pass) using {@link ANALYTICS_RETENTION}.
 *
 * ## Types
 *
 * - `tags` / `metadata` are `jsonb` string maps. A missing key reads as SQL
 *   `NULL`, not `''`: readers wrap `->>` in `coalesce(..., '')` where they
 *   group or compare on it.
 * - `tags_hash` / `pair_hash` are unsigned 64-bit hashes computed in
 *   TypeScript, stored as their decimal text: Postgres has no unsigned 64-bit
 *   integer, and nothing does arithmetic on them.
 * - The `*_reported` flags are `smallint` 0/1, not `boolean`, because readers
 *   multiply and compare them as numbers.
 * - Writer-owned instants are `timestamptz` in string mode: writers produce
 *   ISO strings, and readers convert to epoch milliseconds in SQL.
 * - `day` is a `date` in string mode, `"YYYY-MM-DD"` everywhere in the codebase.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/** A writer-owned instant, millisecond precision, carried as an ISO string. */
function instant(name: string) {
  return timestamp(name, { withTimezone: true, precision: 3, mode: "string" });
}

/** A string-to-string map. */
function stringMap(name: string) {
  return jsonb(name).$type<Record<string, string>>();
}

/**
 * Every property present and non-optional.
 *
 * `Required<T>` is not enough: Drizzle types a defaulted column as
 * `charge_type?: string | undefined`, and dropping the `?` leaves the explicit
 * `| undefined` behind. The writer row types use this so a producer that
 * forgets `charge_type`, `amortized_reported` or `blended_reported` fails to
 * compile: those decide how the row reads, and "left to the default" is not a
 * decision anything writing cost data gets to make implicitly.
 */
export type Complete<T> = { [K in keyof T]-?: Exclude<T[K], undefined> };

/* ------------------------------------------------------------------ *
 * Metrics
 * ------------------------------------------------------------------ */

/**
 * Every metric point a plugin has reported, at the resolution it reported it.
 *
 * The only table carrying `plugin_id` / `resource_type_id`, which is why the
 * metric-alert key picker reads it rather than a rollup. Seven days, because the
 * rollups below are what anything older is answered from.
 */
export const metricPointsRaw = pgTable(
  "metric_points_raw",
  {
    organization_id: text("organization_id").notNull(),
    account_id: text("account_id").notNull(),
    resource_id: text("resource_id").notNull(),
    plugin_id: text("plugin_id").notNull(),
    resource_type_id: text("resource_type_id").notNull(),
    series_label: text("series_label").notNull(),
    unit: text("unit").notNull(),
    ts: instant("ts").notNull(),
    value: doublePrecision("value").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.organization_id, t.resource_id, t.series_label, t.ts] }),
    index("metric_points_raw_org_plugin_type_idx").on(
      t.organization_id,
      t.plugin_id,
      t.resource_type_id,
    ),
    index("metric_points_raw_ts_idx").on(t.ts),
  ],
);

/**
 * Per-minute rollup. Thirty days: the right-sizing window (14 days) and the
 * metric-alert evaluator both live inside it, and both need minute resolution;
 * a p95 of *hourly* averages flattens the peaks a recommendation has to respect.
 */
export const metricPoints1m = pgTable(
  "metric_points_1m",
  {
    organization_id: text("organization_id").notNull(),
    resource_id: text("resource_id").notNull(),
    series_label: text("series_label").notNull(),
    unit: text("unit").notNull(),
    ts_minute: timestamp("ts_minute", { withTimezone: true, mode: "string" }).notNull(),
    value_sum: doublePrecision("value_sum").notNull(),
    value_count: bigint("value_count", { mode: "number" }).notNull(),
    value_min: doublePrecision("value_min").notNull(),
    value_max: doublePrecision("value_max").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.organization_id, t.resource_id, t.series_label, t.ts_minute] }),
    index("metric_points_1m_ts_idx").on(t.ts_minute),
  ],
);

/** Per-hour rollup. A year. */
export const metricPoints1h = pgTable(
  "metric_points_1h",
  {
    organization_id: text("organization_id").notNull(),
    resource_id: text("resource_id").notNull(),
    series_label: text("series_label").notNull(),
    unit: text("unit").notNull(),
    ts_hour: timestamp("ts_hour", { withTimezone: true, mode: "string" }).notNull(),
    value_sum: doublePrecision("value_sum").notNull(),
    value_count: bigint("value_count", { mode: "number" }).notNull(),
    value_min: doublePrecision("value_min").notNull(),
    value_max: doublePrecision("value_max").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.organization_id, t.resource_id, t.series_label, t.ts_hour] }),
    index("metric_points_1h_ts_idx").on(t.ts_hour),
  ],
);

/** Latest `DashboardStat[]` snapshot per resource, stored as JSON text. */
export const dashboardStats = pgTable(
  "dashboard_stats",
  {
    organization_id: text("organization_id").notNull(),
    account_id: text("account_id").notNull(),
    resource_id: text("resource_id").notNull(),
    ts: instant("ts").notNull(),
    stats_json: text("stats_json").notNull(),
  },
  (t) => [
    index("dashboard_stats_resource_ts_idx").on(t.organization_id, t.resource_id, t.ts),
    index("dashboard_stats_ts_idx").on(t.ts),
  ],
);

/** Per-account resource-type counts, stored as JSON text. */
export const accountResourceCounts = pgTable(
  "account_resource_counts",
  {
    organization_id: text("organization_id").notNull(),
    account_id: text("account_id").notNull(),
    ts: instant("ts").notNull(),
    counts_json: text("counts_json").notNull(),
  },
  (t) => [
    index("account_resource_counts_account_ts_idx").on(t.organization_id, t.account_id, t.ts),
    index("account_resource_counts_ts_idx").on(t.ts),
  ],
);

/** One poll's outcome per (account, plugin): the connection health feed. */
export const pollOutcomes = pgTable(
  "poll_outcomes",
  {
    organization_id: text("organization_id").notNull(),
    account_id: text("account_id").notNull(),
    plugin_id: text("plugin_id").notNull(),
    ts: instant("ts").notNull(),
    duration_ms: integer("duration_ms").notNull(),
    resource_count: integer("resource_count").notNull(),
    succeeded_type_count: integer("succeeded_type_count").notNull(),
    failed_type_count: integer("failed_type_count").notNull(),
    skipped_type_count: integer("skipped_type_count").notNull(),
    first_error: text("first_error").notNull(),
  },
  (t) => [
    index("poll_outcomes_account_ts_idx").on(t.organization_id, t.account_id, t.ts),
    index("poll_outcomes_ts_idx").on(t.ts),
  ],
);

/* ------------------------------------------------------------------ *
 * Cost
 * ------------------------------------------------------------------ */

/**
 * Columns `cost_daily` and `ai_cost_attributed` share, so the cost readers can
 * swap the attributed view in for the AI rows of a day
 * (`analytics/cost-readers.ts` `attributedCostSource`).
 */
function costColumns() {
  return {
    organization_id: text("organization_id").notNull(),
    account_id: text("account_id").notNull(),
    plugin_id: text("plugin_id").notNull(),
    day: date("day", { mode: "string" }).notNull(),
    service: text("service").notNull(),
    region: text("region").notNull(),
    resource_id: text("resource_id").notNull(),
    tags: stringMap("tags").notNull(),
    tags_hash: text("tags_hash").notNull(),
    currency: text("currency").notNull(),
    amount: doublePrecision("amount").notNull(),
    usage_amount: doublePrecision("usage_amount").notNull(),
    usage_unit: text("usage_unit").notNull(),
    ingested_at: timestamp("ingested_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    /**
     * What kind of charge a row is (usage, a commitment purchase, a credit,
     * tax…). The back catalogue defaults to usage because that is what it is.
     */
    charge_type: text("charge_type").notNull().default("usage"),
    /**
     * The same money spread over the period it covers, when the provider
     * reports one. Readers fall back to `amount` when it was not reported.
     */
    amortized_amount: doublePrecision("amortized_amount").notNull().default(0),
    /**
     * Whether `amortized_amount` was reported at all, as opposed to defaulted.
     *
     * The pair is needed because **0 is a meaningful amortized amount**: a
     * commitment purchase's honest amortized value on its purchase day is zero
     * (the cash landed there, the value belongs to the days it buys). Without
     * this flag the reader's `amortized_amount != 0` test reads that honest zero
     * as "not reported" and falls back to the full cash amount, so the
     * amortized view would show the purchase at full price *and* every amortized
     * slice of it, double-counting the exact thing amortization exists to
     * smooth.
     */
    amortized_reported: smallint("amortized_reported").notNull().default(0),
    /**
     * Provider-native id of the reservation / savings plan / committed-use
     * discount a row is attributable to. Empty for everything else.
     */
    commitment_id: text("commitment_id").notNull().default(""),
  };
}

/**
 * Daily cost rows collected from provider billing APIs, keyed on the full
 * dimension tuple; see the file header for how a re-fetch replaces a row.
 * Three years of retention.
 */
export const costDaily = pgTable(
  "cost_daily",
  {
    ...costColumns(),
    /**
     * The same consumption at the provider's public on-demand list price, when
     * the provider reports one (`CostRow.listAmount`), or when the amount was
     * itself derived from list prices (an `estimated` plugin). Read only by
     * managed-account invoices that re-rate to public pricing.
     */
    list_amount: doublePrecision("list_amount").notNull().default(0),
    /**
     * Whether `list_amount` was reported, as opposed to defaulted. The same
     * pair `amortized_*` uses and for the same reason: a list price of zero
     * (free-tier usage) is an answer, and "no list price" must fall back to
     * the uplift instead of re-rating the line to nothing.
     */
    list_reported: smallint("list_reported").notNull().default(0),
    /**
     * The row's amount with commitment discounts blended: re-priced at the
     * effective rate its pool shares (see plugin-base `cost-blending.ts`).
     * Readers fall back to the amortized amount when it was not reported.
     */
    blended_amount: doublePrecision("blended_amount").notNull().default(0),
    /**
     * Whether `blended_amount` was reported, as opposed to defaulted. Zero is
     * a meaningful blended amount (a covered row whose share of a pool is
     * nothing), so "reported" lives apart from the value, exactly as
     * `amortized_reported` does.
     */
    blended_reported: smallint("blended_reported").notNull().default(0),
    /**
     * What a commitment-covered row's consumption would have cost on demand,
     * at the account's own rates (`CostRow.onDemandAmount`). Only covered rows
     * carry it; uncovered usage's amortized amount already is its on-demand
     * cost. Read by commitment reports for savings.
     */
    on_demand_amount: doublePrecision("on_demand_amount").notNull().default(0),
    /**
     * Whether `on_demand_amount` was reported. Absent means "the provider did
     * not say", and savings readers count such a row as having saved nothing
     * rather than reading a zero on-demand cost as a 100% loss.
     */
    on_demand_reported: smallint("on_demand_reported").notNull().default(0),
  },
  (t) => [
    primaryKey({
      name: "cost_daily_pkey",
      columns: [
        t.organization_id,
        t.account_id,
        t.day,
        t.service,
        t.region,
        t.resource_id,
        t.tags_hash,
        t.currency,
      ],
    }),
    index("cost_daily_org_day_idx").on(t.organization_id, t.day),
    index("cost_daily_org_resource_idx").on(t.organization_id, t.resource_id),
    index("cost_daily_tags_idx").using("gin", t.tags),
  ],
);

/**
 * Priced source→destination traffic pairs.
 *
 * Beside `cost_daily` because it is the same shape of problem (a day-keyed
 * aggregate read as "top N by money over a range"), but a *separate table on
 * purpose*: the money in it is flow logs times a published rate card, and
 * folding it into `cost_daily` would add a second, estimated opinion of
 * data-transfer spend on top of the provider's own billed line, double-counting
 * every budget, anomaly, export and invoice that reads that table. Nothing joins
 * the two.
 *
 * **It is affordable only because the aggregation already happened.** Raw flow
 * logs are gigabytes a day per VPC. The plugin groups them inside the provider's
 * own query engine, and `network-flow/aggregate.ts` caps what is stored at 500
 * pairs plus one residual row per (scope, direction) per account-day: ≤518
 * rows, hard, whatever the network does.
 *
 * Ninety days rather than three years because flow data explains a bill, it is
 * not a record of one: nothing reconciles against it, and providers commonly
 * retain their own flow logs for 7 or 30 days so older days cannot be
 * recollected anyway.
 */
export const networkFlowDaily = pgTable(
  "network_flow_daily",
  {
    organization_id: text("organization_id").notNull(),
    account_id: text("account_id").notNull(),
    plugin_id: text("plugin_id").notNull(),
    day: date("day", { mode: "string" }).notNull(),
    scope: text("scope").notNull(),
    direction: text("direction").notNull(),
    attribution: text("attribution").notNull(),
    pair_hash: text("pair_hash").notNull(),
    src_ref: text("src_ref").notNull(),
    src_label: text("src_label").notNull(),
    src_zone: text("src_zone").notNull(),
    src_region: text("src_region").notNull(),
    src_service: text("src_service").notNull(),
    src_resource_type_id: text("src_resource_type_id").notNull(),
    dst_ref: text("dst_ref").notNull(),
    dst_label: text("dst_label").notNull(),
    dst_zone: text("dst_zone").notNull(),
    dst_region: text("dst_region").notNull(),
    dst_service: text("dst_service").notNull(),
    dst_resource_type_id: text("dst_resource_type_id").notNull(),
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    packets: bigint("packets", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    rate_per_gb: doublePrecision("rate_per_gb").notNull(),
    estimated_cost: doublePrecision("estimated_cost").notNull(),
    /**
     * How the row's bytes and boundary were established (`flow_log`,
     * `in_cluster_flows`, `counter_estimate`), or "" for a plugin with only one
     * method and for residual rows. Describes a row, does not distinguish one,
     * so it is outside the key.
     */
    method: text("method").notNull().default(""),
    /**
     * The private network each endpoint sits in (a VPC id), when the plugin
     * reports it. Outside the key and the pair hash, like `method`: it
     * describes an endpoint, and saved network flow reports filter and group by
     * it.
     */
    src_network: text("src_network").notNull().default(""),
    dst_network: text("dst_network").notNull().default(""),
    ingested_at: timestamp("ingested_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({
      name: "network_flow_daily_pkey",
      columns: [
        t.organization_id,
        t.account_id,
        t.day,
        t.scope,
        t.direction,
        t.attribution,
        t.pair_hash,
      ],
    }),
    index("network_flow_daily_org_day_idx").on(t.organization_id, t.day),
  ],
);

/**
 * Per-day AI request aggregates from the request-log sources: one row per
 * (source, provider, model, mapped metadata) per collection.
 *
 * **Never raw requests.** Plugins fold records into aggregates while streaming
 * (`AiRequestAccumulator`), capped at a few thousand rows per source-day, so
 * a gateway doing millions of requests a day stores the same handful of rows
 * as one doing a hundred. Only metadata keys the org mapped to a dimension
 * are kept; a per-request id or user email never lands here unless someone
 * mapped that key.
 *
 * Append-only with a `collected_at` per collection: changing a mapping changes
 * the metadata, so a re-collection writes *different* rows and an upsert would
 * leave the old ones behind. 400 days: enough to re-attribute a year of history
 * when a bill restates, after which the attributed split below is what remains.
 */
export const aiRequestDaily = pgTable(
  "ai_request_daily",
  {
    organization_id: text("organization_id").notNull(),
    source_id: text("source_id").notNull(),
    day: date("day", { mode: "string" }).notNull(),
    collected_at: instant("collected_at").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    metadata: stringMap("metadata").notNull(),
    requests: bigint("requests", { mode: "number" }).notNull(),
    input_tokens: bigint("input_tokens", { mode: "number" }).notNull(),
    output_tokens: bigint("output_tokens", { mode: "number" }).notNull(),
    cache_read_tokens: bigint("cache_read_tokens", { mode: "number" }).notNull(),
    cache_write_tokens: bigint("cache_write_tokens", { mode: "number" }).notNull(),
    reasoning_tokens: bigint("reasoning_tokens", { mode: "number" }).notNull(),
    /** Gateway-reported cost; `reported_cost_known = 0` means none was reported. */
    reported_cost: doublePrecision("reported_cost").notNull(),
    reported_cost_known: smallint("reported_cost_known").notNull(),
    reported_currency: text("reported_currency").notNull(),
  },
  (t) => [
    index("ai_request_daily_org_day_source_idx").on(
      t.organization_id,
      t.day,
      t.source_id,
      t.collected_at,
    ),
  ],
);

/**
 * The attributed view of billed AI spend: every AI-tagged `cost_daily` row of
 * an org-day, split by caller, with `caller:<dimension>` tags added and an
 * explicit `(unattributed)` share.
 *
 * **Billed totals are untouched by construction.** Each billed row's splits sum
 * to that row's amount, and `cost_daily` itself is never written. A run
 * rewrites a whole org-day at a new `run_at`; readers take the latest run per
 * day, so a run is atomic for readers and no tombstones are needed. Three
 * years, like `cost_daily`, because it is a view of the bill a report may be
 * asked about.
 */
export const aiCostAttributed = pgTable(
  "ai_cost_attributed",
  {
    ...costColumns(),
    run_at: instant("run_at").notNull(),
  },
  (t) => [index("ai_cost_attributed_org_day_run_idx").on(t.organization_id, t.day, t.run_at)],
);

/**
 * How long each analytics table keeps a row, and the column the age is
 * measured on. `analytics/retention.ts` is the only reader.
 */
export const ANALYTICS_RETENTION = [
  { table: metricPointsRaw, column: metricPointsRaw.ts, keep: sql`interval '7 days'` },
  { table: metricPoints1m, column: metricPoints1m.ts_minute, keep: sql`interval '30 days'` },
  { table: metricPoints1h, column: metricPoints1h.ts_hour, keep: sql`interval '365 days'` },
  { table: dashboardStats, column: dashboardStats.ts, keep: sql`interval '30 days'` },
  {
    table: accountResourceCounts,
    column: accountResourceCounts.ts,
    keep: sql`interval '30 days'`,
  },
  { table: pollOutcomes, column: pollOutcomes.ts, keep: sql`interval '30 days'` },
  { table: costDaily, column: costDaily.day, keep: sql`interval '3 years'` },
  { table: networkFlowDaily, column: networkFlowDaily.day, keep: sql`interval '90 days'` },
  { table: aiRequestDaily, column: aiRequestDaily.day, keep: sql`interval '400 days'` },
  { table: aiCostAttributed, column: aiCostAttributed.day, keep: sql`interval '3 years'` },
] as const;
