import { getClickHouseClient, isClickHouseConfigured } from "./client";

const STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS metric_points_raw (
    organization_id  String,
    account_id       String,
    resource_id      String,
    plugin_id        LowCardinality(String),
    resource_type_id LowCardinality(String),
    series_label     LowCardinality(String),
    unit             LowCardinality(String),
    ts               DateTime64(3),
    value            Float64
  )
  ENGINE = MergeTree
  PARTITION BY toYYYYMM(ts)
  ORDER BY (organization_id, resource_id, series_label, ts)
  TTL toDateTime(ts) + INTERVAL 7 DAY`,

  `CREATE TABLE IF NOT EXISTS metric_points_1m (
    organization_id String,
    resource_id     String,
    series_label    LowCardinality(String),
    unit            LowCardinality(String),
    ts_minute       DateTime,
    value_avg       AggregateFunction(avg, Float64),
    value_min       AggregateFunction(min, Float64),
    value_max       AggregateFunction(max, Float64)
  ) ENGINE = AggregatingMergeTree
  PARTITION BY toYYYYMM(ts_minute)
  ORDER BY (organization_id, resource_id, series_label, ts_minute)
  TTL ts_minute + INTERVAL 30 DAY`,

  `CREATE MATERIALIZED VIEW IF NOT EXISTS mv_metric_points_1m TO metric_points_1m AS
  SELECT organization_id,
         resource_id,
         series_label,
         unit,
         toStartOfMinute(toDateTime(ts)) AS ts_minute,
         avgState(value) AS value_avg,
         minState(value) AS value_min,
         maxState(value) AS value_max
  FROM metric_points_raw
  GROUP BY organization_id, resource_id, series_label, unit, ts_minute`,

  `CREATE TABLE IF NOT EXISTS metric_points_1h (
    organization_id String,
    resource_id     String,
    series_label    LowCardinality(String),
    unit            LowCardinality(String),
    ts_hour         DateTime,
    value_avg       AggregateFunction(avg, Float64),
    value_min       AggregateFunction(min, Float64),
    value_max       AggregateFunction(max, Float64)
  ) ENGINE = AggregatingMergeTree
  PARTITION BY toYYYYMM(ts_hour)
  ORDER BY (organization_id, resource_id, series_label, ts_hour)
  TTL ts_hour + INTERVAL 365 DAY`,

  `CREATE MATERIALIZED VIEW IF NOT EXISTS mv_metric_points_1h TO metric_points_1h AS
  SELECT organization_id,
         resource_id,
         series_label,
         unit,
         toStartOfHour(ts_minute) AS ts_hour,
         avgMergeState(value_avg) AS value_avg,
         minMergeState(value_min) AS value_min,
         maxMergeState(value_max) AS value_max
  FROM metric_points_1m
  GROUP BY organization_id, resource_id, series_label, unit, ts_hour`,

  `CREATE TABLE IF NOT EXISTS dashboard_stats (
    organization_id String,
    account_id      String,
    resource_id     String,
    ts              DateTime,
    stats_json      String
  ) ENGINE = MergeTree
  PARTITION BY toYYYYMM(ts)
  ORDER BY (organization_id, resource_id, ts)
  TTL ts + INTERVAL 30 DAY`,

  `CREATE TABLE IF NOT EXISTS account_resource_counts (
    organization_id String,
    account_id      String,
    ts              DateTime,
    counts_json     String
  ) ENGINE = MergeTree
  ORDER BY (organization_id, account_id, ts)
  TTL ts + INTERVAL 30 DAY`,

  // Daily cost rows collected from provider billing APIs. ReplacingMergeTree
  // keyed on the full dimension tuple: re-fetching a day (restatement window,
  // backfill retry) writes newer ingested_at versions that supersede the old
  // rows — readers query with FINAL. tags_hash is a writer-computed stable
  // hash of the canonicalized tags map, included in the key because Map
  // columns can't be key columns and rows differing only by tags must not
  // collapse. NOTE: the ORDER BY is frozen once shipped (this file has no
  // ALTER path).
  `CREATE TABLE IF NOT EXISTS cost_daily (
    organization_id String,
    account_id      String,
    plugin_id       LowCardinality(String),
    day             Date,
    service         LowCardinality(String),
    region          LowCardinality(String),
    resource_id     String,
    tags            Map(LowCardinality(String), String),
    tags_hash       UInt64,
    currency        LowCardinality(String),
    amount          Float64,
    usage_amount    Float64,
    usage_unit      LowCardinality(String),
    ingested_at     DateTime DEFAULT now()
  ) ENGINE = ReplacingMergeTree(ingested_at)
  PARTITION BY toYYYYMM(day)
  ORDER BY (organization_id, account_id, day, service, region, resource_id, tags_hash, currency)
  TTL day + INTERVAL 3 YEAR`,

  `CREATE TABLE IF NOT EXISTS poll_outcomes (
    organization_id      String,
    account_id           String,
    plugin_id            LowCardinality(String),
    ts                   DateTime,
    duration_ms          UInt32,
    resource_count       UInt32,
    succeeded_type_count UInt16,
    failed_type_count    UInt16,
    skipped_type_count   UInt16,
    first_error          String
  ) ENGINE = MergeTree
  PARTITION BY toYYYYMM(ts)
  ORDER BY (organization_id, account_id, ts)
  TTL ts + INTERVAL 30 DAY`,
];

/**
 * Rewrites MergeTree-family engines to their Replicated* counterparts.
 * ClickHouse Cloud replicates plain MergeTree DDL transparently, but on the
 * self-hosted 2-replica cluster (infra/terraform/clickhouse.tf) only
 * Replicated* engines replicate data. Engine arguments are preserved —
 * `ReplacingMergeTree(ingested_at)` becomes
 * `ReplicatedReplacingMergeTree(ingested_at)` — and the ZooKeeper
 * path/replica arguments are deliberately omitted: the tables live in a
 * `Replicated` database, which derives them.
 *
 * Exported for tests only.
 */
export function withReplicatedEngines(stmt: string): string {
  return stmt.replace(/ENGINE = (?=\w*MergeTree)/, "ENGINE = Replicated");
}

/**
 * Idempotently create the metrics schema. Safe to call on every boot.
 * No-op when CLICKHOUSE_METRICS_* is not configured (local dev / tests).
 *
 * CLICKHOUSE_METRICS_REPLICATED=1 switches the DDL to Replicated* engines.
 * Set it for the in-cluster deployment; never against ClickHouse Cloud,
 * which rejects ReplicatedMergeTree.
 */
export async function migrateMetrics(): Promise<void> {
  if (!isClickHouseConfigured()) {
    console.log("[clickhouse] metrics not configured — skipping migrate");
    return;
  }
  const replicated = process.env["CLICKHOUSE_METRICS_REPLICATED"] === "1";
  const ch = getClickHouseClient();
  for (const stmt of STATEMENTS) {
    await ch.command({ query: replicated ? withReplicatedEngines(stmt) : stmt });
  }
}
