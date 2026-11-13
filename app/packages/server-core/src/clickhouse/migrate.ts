import { getTableName, sql, type SQL } from "drizzle-orm";
import {
  ClickHouseDialect,
  createTableSQL,
  QueryBuilder,
  type ClickHouseColumn,
  type ClickHouseTable,
} from "drizzle-orm/clickhouse-core";
import { getClickHouseClient, isClickHouseConfigured } from "./client";
import {
  CLICKHOUSE_TABLES,
  costDaily,
  metricPoints1h,
  metricPoints1m,
  metricPointsRaw,
  networkFlowDaily,
} from "./schema";

const dialect = new ClickHouseDialect();
const qb = new QueryBuilder();

/** Render a SQL fragment as DDL, where columns are bare names rather than `table`.`column`. */
function ddl(fragment: SQL): string {
  return dialect.sqlToQuery(fragment, "indexes").sql;
}

/* ------------------------------------------------------------------ *
 * Materialized views.
 *
 * The dialect has no materialized-view builder, so the `CREATE MATERIALIZED
 * VIEW … TO … AS` wrapper is written out, but the SELECT inside it is built
 * with the query builder against the same tables everything else reads. That is
 * the point: renaming a column in `schema.ts` fails to compile here rather than
 * silently producing a view that writes into nothing.
 * ------------------------------------------------------------------ */

function materializedView(name: string, target: ClickHouseTable, body: SQL): string {
  return ddl(
    sql`CREATE MATERIALIZED VIEW IF NOT EXISTS ${sql.identifier(name)} TO ${sql.identifier(
      getTableName(target),
    )} AS ${body}`,
  );
}

/**
 * Raw points → per-minute aggregate states.
 *
 * `unit` is in the GROUP BY but not in the target's sort key: a series whose
 * unit string changes mid-minute produces two rows that the AggregatingMergeTree
 * then merges, which is the behaviour we want (the states combine; the unit is
 * whichever survived).
 */
const MV_METRIC_POINTS_1M = materializedView(
  "mv_metric_points_1m",
  metricPoints1m,
  qb
    .select({
      organization_id: metricPointsRaw.organization_id,
      resource_id: metricPointsRaw.resource_id,
      series_label: metricPointsRaw.series_label,
      unit: metricPointsRaw.unit,
      ts_minute: sql`toStartOfMinute(toDateTime(${metricPointsRaw.ts}))`.as("ts_minute"),
      value_avg: sql`avgState(${metricPointsRaw.value})`.as("value_avg"),
      value_min: sql`minState(${metricPointsRaw.value})`.as("value_min"),
      value_max: sql`maxState(${metricPointsRaw.value})`.as("value_max"),
    })
    .from(metricPointsRaw)
    .groupBy(
      metricPointsRaw.organization_id,
      metricPointsRaw.resource_id,
      metricPointsRaw.series_label,
      metricPointsRaw.unit,
      sql`ts_minute`,
    )
    .getSQL(),
);

/** Per-minute states → per-hour states, via `*MergeState` so nothing is finalized twice. */
const MV_METRIC_POINTS_1H = materializedView(
  "mv_metric_points_1h",
  metricPoints1h,
  qb
    .select({
      organization_id: metricPoints1m.organization_id,
      resource_id: metricPoints1m.resource_id,
      series_label: metricPoints1m.series_label,
      unit: metricPoints1m.unit,
      ts_hour: sql`toStartOfHour(${metricPoints1m.ts_minute})`.as("ts_hour"),
      value_avg: sql`avgMergeState(${metricPoints1m.value_avg})`.as("value_avg"),
      value_min: sql`minMergeState(${metricPoints1m.value_min})`.as("value_min"),
      value_max: sql`maxMergeState(${metricPoints1m.value_max})`.as("value_max"),
    })
    .from(metricPoints1m)
    .groupBy(
      metricPoints1m.organization_id,
      metricPoints1m.resource_id,
      metricPoints1m.series_label,
      metricPoints1m.unit,
      sql`ts_hour`,
    )
    .getSQL(),
);

/* ------------------------------------------------------------------ *
 * Additive column migrations.
 *
 * The CREATEs above are all `IF NOT EXISTS`, which does nothing to a table that
 * already exists, so a column added to a table in `schema.ts` after it shipped
 * never appears on any deployment that already ran. That is what these are for.
 *
 * The rules, all three load-bearing:
 *
 * 1. `ADD COLUMN IF NOT EXISTS` is idempotent, so these run on every boot
 *    alongside the CREATEs and are a no-op after the first time. They must stay
 *    idempotent: no bare `ADD COLUMN`, no `MODIFY`, no `DROP`.
 * 2. They may only ADD. A sort key cannot be changed by ALTER, and for
 *    `cost_daily` it must not be changed at all: the ORDER BY *is* the
 *    ReplacingMergeTree identity of a row, and rewriting it would re-key (and
 *    silently merge away) three years of history. A new dimension that needs to
 *    keep rows distinct is folded into `tags_hash` instead: see
 *    `cost-writers.ts`.
 * 3. Every added column carries a DEFAULT, because rows written before it
 *    existed have no value for it. `charge_type DEFAULT 'usage'` is what makes
 *    the entire back catalogue read as usage (which is what it is) rather than
 *    as an empty string that matches no filter. The default is declared on the
 *    column in `schema.ts` and rendered from there, so the CREATE and the ALTER
 *    cannot disagree about it.
 *
 * `withReplicatedEngines` does not apply here: it rewrites `ENGINE = ` in a
 * CREATE, and an ALTER names no engine. On the replicated cluster these run
 * against a `Replicated` database, which propagates the DDL itself.
 * ------------------------------------------------------------------ */

/** Columns added to a table after it shipped, in the order they were added. */
const ADDITIVE_COLUMNS: Array<[ClickHouseTable, ClickHouseColumn]> = [
  [costDaily, costDaily.charge_type],
  [costDaily, costDaily.amortized_amount],
  [costDaily, costDaily.amortized_reported],
  [costDaily, costDaily.commitment_id],
  [costDaily, costDaily.list_amount],
  [costDaily, costDaily.list_reported],
  [networkFlowDaily, networkFlowDaily.method],
  [networkFlowDaily, networkFlowDaily.src_network],
  [networkFlowDaily, networkFlowDaily.dst_network],
  [costDaily, costDaily.blended_amount],
  [costDaily, costDaily.blended_reported],
];

function addColumnSQL(table: ClickHouseTable, column: ClickHouseColumn): string {
  return ddl(
    sql`ALTER TABLE ${sql.identifier(getTableName(table))} ADD COLUMN IF NOT EXISTS ${dialect.buildColumnDefinition(column)}`,
  );
}

/* ------------------------------------------------------------------ *
 * Dimensions outside the sorting key.
 *
 * `metric_points_1m` and `metric_points_1h` keep `unit` beside their sort key
 * rather than in it: a series has one unit, so the value a merge keeps is the
 * value (see the materialized view above). ClickHouse 26.7 started rejecting
 * that at CREATE (#1116): an AggregatingMergeTree column that is neither in
 * the sorting key nor an aggregate state needs the MergeTree setting
 * `allow_dimensions_outside_sorting_key = 1`, which 26.7 turned off by
 * default. Servers before the setting existed (24.8) reject it as unknown, so
 * the clause is added only where `system.merge_tree_settings` lists it.
 *
 * Only CREATE checks, so tables that already exist keep loading on any
 * version, and no ALTER is needed for them. The alternative, making `unit` a
 * `SimpleAggregateFunction(anyLast, ...)`, would be a MODIFY COLUMN on tables
 * that already exist, which rewrites their parts and which the rules for
 * additive migrations above do not allow.
 * ------------------------------------------------------------------ */

const DIMENSIONS_SETTING = "allow_dimensions_outside_sorting_key";

/** Appends the setting to a CREATE of an AggregatingMergeTree table. Exported for tests. */
export function withDimensionsOutsideSortingKey(stmt: string): string {
  if (!/ENGINE = AggregatingMergeTree\b/.test(stmt)) return stmt;
  return `${stmt} SETTINGS ${DIMENSIONS_SETTING} = 1`;
}

/** Whether the server has the MergeTree setting at all (26.x does, 24.8 does not). */
async function serverHasMergeTreeSetting(name: string): Promise<boolean> {
  const result = await getClickHouseClient().query({
    query: "SELECT count() AS n FROM system.merge_tree_settings WHERE name = {name:String}",
    query_params: { name },
    format: "JSONEachRow",
  });
  const rows = await result.json<{ n: number | string }>();
  return Number(rows[0]?.n ?? 0) > 0;
}

export interface MigrationOptions {
  /** The server has `allow_dimensions_outside_sorting_key` (see above). */
  allowDimensionsOutsideSortingKey?: boolean;
}

/**
 * Every statement `migrateMetrics` issues, in order: tables, then the views that
 * read them, then the columns the tables gained after shipping.
 *
 * Exported for the tests, which assert that each one is idempotent.
 */
export function migrationStatements(options: MigrationOptions = {}): string[] {
  const create = (table: ClickHouseTable) => {
    const stmt = createTableSQL(table, { ifNotExists: true });
    return options.allowDimensionsOutsideSortingKey ? withDimensionsOutsideSortingKey(stmt) : stmt;
  };
  return [
    ...CLICKHOUSE_TABLES.map(create),
    MV_METRIC_POINTS_1M,
    MV_METRIC_POINTS_1H,
    ...ADDITIVE_COLUMNS.map(([table, column]) => addColumnSQL(table, column)),
  ];
}

/**
 * Rewrites MergeTree-family engines to their Replicated* counterparts.
 * ClickHouse Cloud replicates plain MergeTree DDL transparently, but on the
 * self-hosted 2-replica cluster (infra/terraform/clickhouse.tf) only
 * Replicated* engines replicate data. Engine arguments are preserved;
 * `ReplacingMergeTree(ingested_at)` becomes
 * `ReplicatedReplacingMergeTree(ingested_at)`, and the ZooKeeper
 * path/replica arguments are deliberately omitted: the tables live in a
 * `Replicated` database, which derives them.
 *
 * A string rewrite rather than the dialect's own `replicated` engine option,
 * because that option is fixed when the table is declared and this is a
 * per-deployment decision read from the environment at migrate time.
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
    console.log("[clickhouse] metrics not configured; skipping migrate");
    return;
  }
  const replicated = process.env["CLICKHOUSE_METRICS_REPLICATED"] === "1";
  const allowDimensionsOutsideSortingKey = await serverHasMergeTreeSetting(DIMENSIONS_SETTING);
  const ch = getClickHouseClient();
  for (const stmt of migrationStatements({ allowDimensionsOutsideSortingKey })) {
    await ch.command({ query: replicated ? withReplicatedEngines(stmt) : stmt });
  }
}
