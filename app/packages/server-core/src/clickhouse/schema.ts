/**
 * The metrics cluster's schema, as Drizzle tables.
 *
 * This is the single description of what ClickHouse holds: `migrate.ts` renders
 * the DDL from it, every reader and writer in this directory selects and inserts
 * through it, and a column that does not exist here cannot be referenced by a
 * query that compiles. Nothing in the codebase spells a metrics table or column
 * name as a string any more.
 *
 * ## Property names are the ClickHouse column names
 *
 * Drizzle's convention is a camelCase property mapped onto a snake_case column.
 * These tables deliberately do not follow it: the property name *is* the column
 * name, so `cost_daily`'s `organization_id` is `organization_id` in TypeScript
 * too. The row shapes here are a wire contract that leaves this process — the
 * cost ingest API accepts them, `cost-reconcile.ts` compares stored rows against
 * about-to-be-written ones field by field, and the export writes them into
 * customer buckets — and every one of those is specified in the database's
 * spelling. A camelCase mirror would put a translation layer between two things
 * that are the same thing.
 *
 * ## Timestamps the writers own are `mode: "string"`
 *
 * Every column a writer fills — `metric_points_raw.ts`, `dashboard_stats.ts`,
 * `poll_outcomes.ts` — is declared `{ mode: "string" }` and carries the ISO
 * instant the writer produced. Those rows go in through `JSONEachRow` (see
 * `writers.ts`), where the value is JSON text that ClickHouse parses itself, not
 * a literal the dialect renders — so `mode: "date"` would buy a `Date` in
 * TypeScript at the cost of a round-trip through a formatter that is not the one
 * doing the parsing. `ingested_at`, which only ever holds the server's `now()`,
 * is left as a `Date`.
 *
 * ## The `Aggregate*` columns
 *
 * `AggregateFunction(avg, Float64)` has no Drizzle builder, so it is declared
 * through {@link aggregateFunction}, a `customType`. Its TypeScript type is
 * `string` and that is honest: an aggregate state is opaque bytes, and nothing
 * ever selects one directly — readers finalize it with `avgMerge(...)` and get a
 * `Float64` back.
 *
 * ## Changing this file changes a live database
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so a
 * column added to a table below never appears on a deployment that already ran.
 * Adding one means adding it here *and* to `ADDITIVE_COLUMNS` in `migrate.ts`.
 * The sort keys of `cost_daily` and `network_flow_daily` are frozen outright —
 * see the commentary in `migrate.ts` for what re-keying them would destroy.
 */
import { sql } from "drizzle-orm";
import {
  aggregatingMergeTree,
  clickhouseTable,
  customType,
  date,
  dateTime,
  dateTime64,
  float64,
  lowCardinality,
  map,
  mergeTree,
  replacingMergeTree,
  string,
  uint8,
  uint16,
  uint32,
  uint64,
} from "drizzle-orm/clickhouse-core";

/**
 * `AggregateFunction(fn, T)` — the partial aggregation state an
 * AggregatingMergeTree stores.
 *
 * Surfaced as `string` because the state is opaque: it is written by a
 * materialized view's `avgState(...)` and read back through `avgMerge(...)`,
 * never handled as a value in TypeScript.
 */
export const aggregateFunction = customType<{
  data: string;
  driverData: string;
  config: { fn: string; type: string };
  configRequired: true;
}>({
  dataType: (config) => `AggregateFunction(${config.fn}, ${config.type})`,
});

/** A `LowCardinality(String)` column — the dictionary-encoded label type. */
function label(name: string) {
  return lowCardinality(name, string());
}

/**
 * Every property present and non-optional.
 *
 * `Required<T>` is not enough: Drizzle types a defaulted column as
 * `charge_type?: string | undefined`, and dropping the `?` leaves the explicit
 * `| undefined` behind. The writer row types below use this so a producer that
 * forgets `charge_type` or `amortized_reported` fails to compile — those two
 * decide how the row reads, and "left to the default" is not a decision anything
 * writing cost data gets to make implicitly.
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
export const metricPointsRaw = clickhouseTable(
  "metric_points_raw",
  {
    organization_id: string().notNull(),
    account_id: string().notNull(),
    resource_id: string().notNull(),
    plugin_id: label("plugin_id").notNull(),
    resource_type_id: label("resource_type_id").notNull(),
    series_label: label("series_label").notNull(),
    unit: label("unit").notNull(),
    ts: dateTime64({ precision: 3, mode: "string" }).notNull(),
    value: float64().notNull(),
  },
  (t) => [
    mergeTree({
      partitionBy: sql`toYYYYMM(${t.ts})`,
      orderBy: [t.organization_id, t.resource_id, t.series_label, t.ts],
      ttl: sql`toDateTime(${t.ts}) + INTERVAL 7 DAY`,
    }),
  ],
);

/**
 * Per-minute avg/min/max states, fed by `mv_metric_points_1m`. Thirty days: the
 * right-sizing window (14 days) and the metric-alert evaluator both live inside
 * it, and both need minute resolution — a p95 of *hourly* averages flattens the
 * peaks a recommendation has to respect.
 */
export const metricPoints1m = clickhouseTable(
  "metric_points_1m",
  {
    organization_id: string().notNull(),
    resource_id: string().notNull(),
    series_label: label("series_label").notNull(),
    unit: label("unit").notNull(),
    ts_minute: dateTime().notNull(),
    value_avg: aggregateFunction("value_avg", { fn: "avg", type: "Float64" }).notNull(),
    value_min: aggregateFunction("value_min", { fn: "min", type: "Float64" }).notNull(),
    value_max: aggregateFunction("value_max", { fn: "max", type: "Float64" }).notNull(),
  },
  (t) => [
    aggregatingMergeTree({
      partitionBy: sql`toYYYYMM(${t.ts_minute})`,
      orderBy: [t.organization_id, t.resource_id, t.series_label, t.ts_minute],
      ttl: sql`${t.ts_minute} + INTERVAL 30 DAY`,
    }),
  ],
);

/** Per-hour states, fed by `mv_metric_points_1h` off the 1m rollup. A year. */
export const metricPoints1h = clickhouseTable(
  "metric_points_1h",
  {
    organization_id: string().notNull(),
    resource_id: string().notNull(),
    series_label: label("series_label").notNull(),
    unit: label("unit").notNull(),
    ts_hour: dateTime().notNull(),
    value_avg: aggregateFunction("value_avg", { fn: "avg", type: "Float64" }).notNull(),
    value_min: aggregateFunction("value_min", { fn: "min", type: "Float64" }).notNull(),
    value_max: aggregateFunction("value_max", { fn: "max", type: "Float64" }).notNull(),
  },
  (t) => [
    aggregatingMergeTree({
      partitionBy: sql`toYYYYMM(${t.ts_hour})`,
      orderBy: [t.organization_id, t.resource_id, t.series_label, t.ts_hour],
      ttl: sql`${t.ts_hour} + INTERVAL 365 DAY`,
    }),
  ],
);

/** Latest `DashboardStat[]` snapshot per resource, stored as JSON text. */
export const dashboardStats = clickhouseTable(
  "dashboard_stats",
  {
    organization_id: string().notNull(),
    account_id: string().notNull(),
    resource_id: string().notNull(),
    ts: dateTime({ mode: "string" }).notNull(),
    stats_json: string().notNull(),
  },
  (t) => [
    mergeTree({
      partitionBy: sql`toYYYYMM(${t.ts})`,
      orderBy: [t.organization_id, t.resource_id, t.ts],
      ttl: sql`${t.ts} + INTERVAL 30 DAY`,
    }),
  ],
);

/** Per-account resource-type counts, stored as JSON text. */
export const accountResourceCounts = clickhouseTable(
  "account_resource_counts",
  {
    organization_id: string().notNull(),
    account_id: string().notNull(),
    ts: dateTime({ mode: "string" }).notNull(),
    counts_json: string().notNull(),
  },
  (t) => [
    mergeTree({
      orderBy: [t.organization_id, t.account_id, t.ts],
      ttl: sql`${t.ts} + INTERVAL 30 DAY`,
    }),
  ],
);

/** One poll's outcome per (account, plugin) — the connection health feed. */
export const pollOutcomes = clickhouseTable(
  "poll_outcomes",
  {
    organization_id: string().notNull(),
    account_id: string().notNull(),
    plugin_id: label("plugin_id").notNull(),
    ts: dateTime({ mode: "string" }).notNull(),
    duration_ms: uint32().notNull(),
    resource_count: uint32().notNull(),
    succeeded_type_count: uint16().notNull(),
    failed_type_count: uint16().notNull(),
    skipped_type_count: uint16().notNull(),
    first_error: string().notNull(),
  },
  (t) => [
    mergeTree({
      partitionBy: sql`toYYYYMM(${t.ts})`,
      orderBy: [t.organization_id, t.account_id, t.ts],
      ttl: sql`${t.ts} + INTERVAL 30 DAY`,
    }),
  ],
);

/* ------------------------------------------------------------------ *
 * Cost
 * ------------------------------------------------------------------ */

/**
 * Daily cost rows collected from provider billing APIs.
 *
 * ReplacingMergeTree keyed on the full dimension tuple: re-fetching a day
 * (restatement window, backfill retry) writes newer `ingested_at` versions that
 * supersede the old rows — readers query with `FINAL`. `tags_hash` is a
 * writer-computed stable hash of the canonicalized tags map, in the key because
 * `Map` columns cannot be key columns and rows differing only by tags must not
 * collapse.
 *
 * **The sort key is frozen.** It is the ReplacingMergeTree identity of a row;
 * rewriting it would re-key — and silently merge away — three years of history.
 * A new dimension that has to keep rows distinct is folded into `tags_hash`
 * instead (see `cost-writers.ts`).
 *
 * `day` and `tags_hash` are surfaced as strings rather than `Date`/`bigint`:
 * a cost day is a calendar day the whole codebase passes around as
 * `"YYYY-MM-DD"`, and the hash is a `UInt64` that has no lossless `number`.
 */
export const costDaily = clickhouseTable(
  "cost_daily",
  {
    organization_id: string().notNull(),
    account_id: string().notNull(),
    plugin_id: label("plugin_id").notNull(),
    day: date({ mode: "string" }).notNull(),
    service: label("service").notNull(),
    region: label("region").notNull(),
    resource_id: string().notNull(),
    tags: map(label("tags"), string()).notNull(),
    tags_hash: uint64({ mode: "string" }).notNull(),
    currency: label("currency").notNull(),
    amount: float64().notNull(),
    usage_amount: float64().notNull(),
    usage_unit: label("usage_unit").notNull(),
    ingested_at: dateTime()
      .notNull()
      .default(sql`now()`),

    /* --- Additive columns; see ADDITIVE_COLUMNS in migrate.ts. ---------- */

    /**
     * What kind of charge a row is (usage, a commitment purchase, a credit,
     * tax…). The back catalogue defaults to usage because that is what it is.
     */
    charge_type: label("charge_type").notNull().default("usage"),
    /**
     * The same money spread over the period it covers, when the provider
     * reports one. Readers fall back to `amount` when it was not reported.
     */
    amortized_amount: float64().notNull().default(0),
    /**
     * Whether `amortized_amount` was reported at all, as opposed to defaulted.
     *
     * The pair is needed because **0 is a meaningful amortized amount**: a
     * commitment purchase's honest amortized value on its purchase day is zero
     * (the cash landed there, the value belongs to the days it buys). Without
     * this flag the reader's `amortized_amount != 0` test reads that honest zero
     * as "not reported" and falls back to the full cash amount — so the
     * amortized view would show the purchase at full price *and* every amortized
     * slice of it, double-counting the exact thing amortization exists to
     * smooth.
     */
    amortized_reported: uint8().notNull().default(0),
    /**
     * Provider-native id of the reservation / savings plan / committed-use
     * discount a row is attributable to. Empty for everything else.
     */
    commitment_id: string().notNull().default(""),
  },
  (t) => [
    replacingMergeTree({
      version: t.ingested_at,
      partitionBy: sql`toYYYYMM(${t.day})`,
      orderBy: [
        t.organization_id,
        t.account_id,
        t.day,
        t.service,
        t.region,
        t.resource_id,
        t.tags_hash,
        t.currency,
      ],
      ttl: sql`${t.day} + INTERVAL 3 YEAR`,
    }),
  ],
);

/**
 * Priced source→destination traffic pairs.
 *
 * Beside `cost_daily` because it is the same shape of problem (a day-keyed
 * aggregate read as "top N by money over a range"), but a *separate table on
 * purpose*: the money in it is flow logs times a published rate card, and
 * folding it into `cost_daily` would add a second, estimated opinion of
 * data-transfer spend on top of the provider's own billed line — double-counting
 * every budget, anomaly, export and invoice that reads that table. Nothing joins
 * the two.
 *
 * **It is affordable only because the aggregation already happened.** Raw flow
 * logs are gigabytes a day per VPC. The plugin groups them inside the provider's
 * own query engine, and `network-flow/aggregate.ts` caps what is stored at 500
 * pairs plus one residual row per (scope, direction) per account-day — ≤518
 * rows, hard, whatever the network does.
 *
 * `pair_hash` plays the role `tags_hash` plays in `cost_daily`, and the same
 * rule applies: **this sort key is frozen once shipped.** TTL is 90 days rather
 * than three years because flow data explains a bill, it is not a record of one:
 * nothing reconciles against it, and providers commonly retain their own flow
 * logs for 7 or 30 days so older days cannot be recollected anyway.
 */
export const networkFlowDaily = clickhouseTable(
  "network_flow_daily",
  {
    organization_id: string().notNull(),
    account_id: string().notNull(),
    plugin_id: label("plugin_id").notNull(),
    day: date({ mode: "string" }).notNull(),
    scope: label("scope").notNull(),
    direction: label("direction").notNull(),
    attribution: label("attribution").notNull(),
    pair_hash: uint64({ mode: "string" }).notNull(),
    src_ref: string().notNull(),
    src_label: string().notNull(),
    src_zone: label("src_zone").notNull(),
    src_region: label("src_region").notNull(),
    src_service: label("src_service").notNull(),
    src_resource_type_id: label("src_resource_type_id").notNull(),
    dst_ref: string().notNull(),
    dst_label: string().notNull(),
    dst_zone: label("dst_zone").notNull(),
    dst_region: label("dst_region").notNull(),
    dst_service: label("dst_service").notNull(),
    dst_resource_type_id: label("dst_resource_type_id").notNull(),
    bytes: uint64({ mode: "number" }).notNull(),
    packets: uint64({ mode: "number" }).notNull(),
    currency: label("currency").notNull(),
    rate_per_gb: float64().notNull(),
    estimated_cost: float64().notNull(),
    ingested_at: dateTime()
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    replacingMergeTree({
      version: t.ingested_at,
      partitionBy: sql`toYYYYMM(${t.day})`,
      orderBy: [
        t.organization_id,
        t.account_id,
        t.day,
        t.scope,
        t.direction,
        t.attribution,
        t.pair_hash,
      ],
      ttl: sql`${t.day} + INTERVAL 90 DAY`,
    }),
  ],
);

/** Every table `migrateMetrics` creates, in dependency order. */
export const CLICKHOUSE_TABLES = [
  metricPointsRaw,
  metricPoints1m,
  metricPoints1h,
  dashboardStats,
  accountResourceCounts,
  costDaily,
  networkFlowDaily,
  pollOutcomes,
] as const;
