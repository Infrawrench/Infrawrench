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
  // collapse. NOTE: the ORDER BY is frozen once shipped — see the ALTER block
  // below, which may only ever add columns.
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

  /* ------------------------------------------------------------------ *
   * Additive column migrations.
   *
   * Everything above is `CREATE ... IF NOT EXISTS`, which does nothing to a
   * table that already exists — so a column added to a CREATE body after the
   * table shipped never appears on any deployment that already ran. That is
   * what these ALTERs are for.
   *
   * The rules, all three load-bearing:
   *
   * 1. `ADD COLUMN IF NOT EXISTS` is idempotent, so these run on every boot
   *    alongside the CREATEs and are a no-op after the first time. They must
   *    stay idempotent: no bare `ADD COLUMN`, no `MODIFY`, no `DROP`.
   * 2. They may only ADD. A sort key cannot be changed by ALTER, and for
   *    `cost_daily` it must not be changed at all: the ORDER BY *is* the
   *    ReplacingMergeTree identity of a row, and rewriting it would re-key
   *    (and silently merge away) three years of history. A new dimension that
   *    needs to keep rows distinct is folded into `tags_hash` instead — see
   *    `cost-writers.ts`.
   * 3. Every added column carries a DEFAULT, because rows written before it
   *    existed have no value for it. `charge_type DEFAULT 'usage'` is what
   *    makes the entire back catalogue read as usage — which is what it is —
   *    rather than as an empty string that matches no filter.
   *
   * `withReplicatedEngines` does not apply here: it rewrites `ENGINE = ` in a
   * CREATE, and an ALTER names no engine. On the replicated cluster these run
   * against a `Replicated` database, which propagates the DDL itself.
   * ------------------------------------------------------------------ */

  // What kind of charge a row is (usage, a commitment purchase, a credit, tax…).
  // Pre-existing rows are usage: that is what they were always assumed to be.
  `ALTER TABLE cost_daily ADD COLUMN IF NOT EXISTS charge_type LowCardinality(String) DEFAULT 'usage'`,

  // The same money spread over the period it covers, when the provider reports
  // one. Readers fall back to `amount` when it was not reported — see
  // `cost-readers.ts`, where that fallback is the difference between an
  // amortized query and a query that silently drops non-amortizing providers.
  `ALTER TABLE cost_daily ADD COLUMN IF NOT EXISTS amortized_amount Float64 DEFAULT 0`,

  // Whether `amortized_amount` was reported at all, as opposed to defaulted.
  //
  // The pair is needed because **0 is a meaningful amortized amount**: a
  // commitment purchase's honest amortized value on its purchase day is zero
  // (the cash landed there, the value belongs to the days it buys). Without
  // this flag the reader's `amortized_amount != 0` test reads that honest zero
  // as "not reported" and falls back to the full cash amount — so the amortized
  // view would show the purchase at full price *and* every amortized slice of
  // it, double-counting the exact thing amortization exists to smooth.
  //
  // DEFAULT 0 is what makes it safe on the back catalogue: every row written
  // before this column existed reads as "not reported", which drops it onto the
  // legacy `amortized_amount != 0` branch and reproduces today's behaviour
  // exactly — including rows a provider genuinely amortized, whose non-zero
  // `amortized_amount` still wins. Nothing pre-existing changes value.
  `ALTER TABLE cost_daily ADD COLUMN IF NOT EXISTS amortized_reported UInt8 DEFAULT 0`,

  // Provider-native id of the reservation / savings plan / committed-use
  // discount a row is attributable to. Empty for everything else.
  `ALTER TABLE cost_daily ADD COLUMN IF NOT EXISTS commitment_id String DEFAULT ''`,

  /* ------------------------------------------------------------------ *
   * Network flow attribution — priced source→destination pairs.
   *
   * This sits beside `cost_daily` because it is the same shape of problem
   * (a day-keyed analytic aggregate read as "top N by money over a range"),
   * but it is a *separate table on purpose*: the money in it is derived from
   * flow logs times a published rate card, and folding it into `cost_daily`
   * would add a second, estimated opinion of data-transfer spend on top of
   * the provider's own billed `DataTransfer` line — double-counting every
   * budget, anomaly, export and invoice that reads that table. Nothing joins
   * the two; the flow surface is read on its own.
   *
   * **It is affordable only because the aggregation already happened.** Raw
   * flow logs are gigabytes a day per VPC. The plugin groups them inside the
   * provider's own query engine and returns at most a few hundred pairs, and
   * `network-flow/aggregate.ts` caps what is stored at 500 pairs plus one
   * residual row per (scope, direction) per account-day — ≤518 rows, hard,
   * whatever the network does. What falls outside the cap is not dropped: it
   * is subtracted into an explicit `attribution = 'truncated'` row.
   *
   * `pair_hash` plays the role `tags_hash` plays in `cost_daily` — a stable
   * FNV-1a of the six endpoint fields the sort key has no room for, so two
   * different pairs can never collapse into one ReplacingMergeTree version.
   * The same rule applies: **this ORDER BY is frozen once shipped**, and a new
   * dimension that must keep rows distinct is folded into the hash rather than
   * appended to the key.
   *
   * TTL is 90 days rather than `cost_daily`'s three years, and that is the
   * other half of the budget. Flow data explains a bill, it is not a record of
   * one — nothing reconciles against it, the provider's own flow logs are
   * commonly retained for 7 or 30 days so older days cannot be recollected
   * anyway, and retention is the one lever that scales the table linearly.
   * ------------------------------------------------------------------ */
  `CREATE TABLE IF NOT EXISTS network_flow_daily (
    organization_id      String,
    account_id           String,
    plugin_id            LowCardinality(String),
    day                  Date,
    scope                LowCardinality(String),
    direction            LowCardinality(String),
    attribution          LowCardinality(String),
    pair_hash            UInt64,
    src_ref              String,
    src_label            String,
    src_zone             LowCardinality(String),
    src_region           LowCardinality(String),
    src_service          LowCardinality(String),
    src_resource_type_id LowCardinality(String),
    dst_ref              String,
    dst_label            String,
    dst_zone             LowCardinality(String),
    dst_region           LowCardinality(String),
    dst_service          LowCardinality(String),
    dst_resource_type_id LowCardinality(String),
    bytes                UInt64,
    packets              UInt64,
    currency             LowCardinality(String),
    rate_per_gb          Float64,
    estimated_cost       Float64,
    ingested_at          DateTime DEFAULT now()
  ) ENGINE = ReplacingMergeTree(ingested_at)
  PARTITION BY toYYYYMM(day)
  ORDER BY (organization_id, account_id, day, scope, direction, attribution, pair_hash)
  TTL day + INTERVAL 90 DAY`,

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
 * Idempotently create the metrics schema, then apply the additive column
 * migrations. Safe to call on every boot: every statement is `IF NOT EXISTS`.
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
