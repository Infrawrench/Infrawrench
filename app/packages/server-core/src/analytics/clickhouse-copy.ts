/**
 * The one-off copy of the analytics tables out of the retired ClickHouse
 * cluster into Postgres (`scripts/copy-clickhouse-to-postgres.ts` is the
 * command; KNOWLEDGE.md, "Analytics on Postgres: cutover", the runbook).
 * Delete both once production has been cut over.
 *
 * ClickHouse is read over its HTTP interface with plain `fetch`, one page of
 * `JSONEachRow` at a time, so nothing beyond this file is needed on the source
 * side and memory stays bounded by the page size. Three output settings carry
 * the values across without loss: 64-bit integers come quoted (`tags_hash`
 * does not fit a JavaScript number), NaN and infinities come as strings
 * Postgres' `float8` input accepts, and date-times come as ISO 8601 in UTC so
 * the server's time zone cannot shift them.
 *
 * **Safe to rerun, and safe while the app writes.** The copy runs after the
 * code that writes to Postgres is deployed, so a table may already hold newer
 * rows. Tables with a primary key insert with `ON CONFLICT DO NOTHING`: a row
 * the app wrote since (a re-collected cost day, a fresh rollup bucket) wins
 * over the older copy. Tables without one insert only rows that are not
 * already present column for column. Either way a second run inserts nothing.
 */
import { getTableColumns, getTableName, sql, type SQL } from "drizzle-orm";
import { getTableConfig, type PgColumn, type PgTable } from "drizzle-orm/pg-core";
import type { Db } from "../db/client";
import {
  accountResourceCounts,
  aiCostAttributed,
  aiRequestDaily,
  costDaily,
  dashboardStats,
  metricPoints1h,
  metricPoints1m,
  metricPointsRaw,
  networkFlowDaily,
  pollOutcomes,
} from "../db/analytics-schema";

/** Where to read from. */
export interface ClickHouseSource {
  /** The HTTP interface, e.g. `https://clickhouse-gw.infrawrench.com`. */
  url: string;
  user: string;
  password: string;
  database: string;
  /** Sent with every request, e.g. a Cloudflare Access service token. */
  headers?: Record<string, string>;
}

/**
 * Sent as the User-Agent. Not the runtime's default: Cloudflare's bot rules
 * answer some default agents with a 403 before Access is even consulted.
 */
export const COPY_USER_AGENT = "infrawrench-copy/1";

/** Rows per ClickHouse page and per Postgres statement. */
export const COPY_PAGE_SIZE = 5_000;

interface TableSpec {
  table: PgTable;
  /** Read with `FINAL`, for the tables whose engine replaced rows by version. */
  final?: boolean;
  /**
   * ClickHouse expressions for columns that are not copied as they are,
   * keyed by the Postgres column name. Implies grouping by `groupBy`.
   */
  select?: Record<string, string>;
  groupBy?: string[];
}

/**
 * The tables, in the order they are copied.
 *
 * The rollups stored aggregate *states* in ClickHouse and store running
 * sum/count/min/max here. `avgMerge` gives each bucket's average, but no
 * function hands back the count inside an `avg` state, so a copied bucket is
 * stored as `value_sum = avg`, `value_count = 1`: its average, minimum and
 * maximum read back exactly. The only cost is weight, and only where a bucket
 * straddles the cutover: points the app adds to a copied bucket count as much
 * as all of the copied ones together.
 */
const ROLLUP_SELECT = {
  unit: "any(unit)",
  value_sum: "avgMerge(value_avg)",
  value_count: "1",
  value_min: "minMerge(value_min)",
  value_max: "maxMerge(value_max)",
};

export const COPY_TABLES: readonly TableSpec[] = [
  { table: costDaily, final: true },
  { table: networkFlowDaily, final: true },
  { table: aiRequestDaily },
  { table: aiCostAttributed },
  { table: pollOutcomes },
  { table: dashboardStats },
  { table: accountResourceCounts },
  { table: metricPointsRaw },
  {
    table: metricPoints1m,
    select: ROLLUP_SELECT,
    groupBy: ["organization_id", "resource_id", "series_label", "ts_minute"],
  },
  {
    table: metricPoints1h,
    select: ROLLUP_SELECT,
    groupBy: ["organization_id", "resource_id", "series_label", "ts_hour"],
  },
];

export interface TableCopyResult {
  table: string;
  /**
   * Rows the source holds, as the copy sees them: distinct keys for a table
   * with a primary key (a key ClickHouse stored twice is one row here),
   * every row otherwise.
   */
  source: number;
  /** Rows this run inserted (0 on a dry run, and on a rerun). */
  inserted: number;
  /** Rows the Postgres table holds afterwards, including any the app wrote. */
  destination: number;
}

export interface CopyOptions {
  db: Db;
  source: ClickHouseSource;
  dryRun?: boolean;
  /** Copy only these tables (Postgres names). Default: all of them. */
  tables?: readonly string[];
  pageSize?: number;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

/** A ClickHouse identifier, backquoted. Only ever schema-derived names. */
function ident(name: string): string {
  return `\`${name.replace(/`/g, "\\`")}\``;
}

function columnsOf(table: PgTable): PgColumn[] {
  return Object.values(getTableColumns(table));
}

function primaryKeyOf(table: PgTable): string[] {
  return getTableConfig(table).primaryKeys[0]?.columns.map((c) => c.name) ?? [];
}

function isMap(column: PgColumn): boolean {
  return column.getSQLType() === "jsonb";
}

/**
 * The page query. Rows are ordered totally (by key, or by every column for a
 * table without one) so `LIMIT`/`OFFSET` pages neither skip nor repeat a row.
 * Each column is aliased `c_<name>` because an alias equal to a column name
 * would shadow that column inside the aggregate that computes it.
 */
export function pageQuery(spec: TableSpec, limit: number, offset: number): string {
  const name = getTableName(spec.table);
  const columns = columnsOf(spec.table);
  const select = columns
    .map((c) => `${spec.select?.[c.name] ?? ident(c.name)} AS ${ident(`c_${c.name}`)}`)
    .join(", ");
  const key = primaryKeyOf(spec.table);
  const order = spec.groupBy
    ? spec.groupBy.map(ident)
    : key.length > 0
      ? key.map(ident)
      : columns.map((c) => (isMap(c) ? `toString(${ident(c.name)})` : ident(c.name)));
  return [
    `SELECT ${select} FROM ${ident(name)}${spec.final ? " FINAL" : ""}`,
    spec.groupBy ? `GROUP BY ${spec.groupBy.map(ident).join(", ")}` : "",
    `ORDER BY ${order.join(", ")}`,
    `LIMIT ${limit} OFFSET ${offset}`,
    "FORMAT JSONEachRow",
  ]
    .filter(Boolean)
    .join(" ");
}

/** The source count query; see {@link TableCopyResult.source}. */
export function countQuery(spec: TableSpec): string {
  const name = ident(getTableName(spec.table));
  const key = spec.groupBy ?? primaryKeyOf(spec.table);
  const from = `${name}${spec.final ? " FINAL" : ""}`;
  const counted =
    key.length > 0 ? `(SELECT 1 FROM ${from} GROUP BY ${key.map(ident).join(", ")})` : from;
  return `SELECT count() AS n FROM ${counted} FORMAT JSONEachRow`;
}

/** Run one query and parse its `JSONEachRow` body. */
async function queryClickHouse(
  source: ClickHouseSource,
  query: string,
  fetchImpl: typeof fetch,
): Promise<Array<Record<string, unknown>>> {
  const url = new URL(source.url);
  url.searchParams.set("database", source.database);
  url.searchParams.set("output_format_json_quote_64bit_integers", "1");
  url.searchParams.set("output_format_json_quote_denormals", "1");
  url.searchParams.set("date_time_output_format", "iso");
  url.searchParams.set("readonly", "1");
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      ...source.headers,
      "User-Agent": COPY_USER_AGENT,
      "Content-Type": "text/plain; charset=utf-8",
      "X-ClickHouse-User": source.user,
      "X-ClickHouse-Key": source.password,
    },
    body: query,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`ClickHouse answered ${response.status}: ${text.slice(0, 500)}`);
  }
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        // An exception raised after the first rows arrives in the body.
        throw new Error(`ClickHouse sent a line that is not a row: ${line.slice(0, 500)}`);
      }
    });
}

/** Strip the `c_` aliases back to Postgres column names. */
function unalias(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k.startsWith("c_") ? k.slice(2) : k] = v;
  return out;
}

function countOf(rows: Array<Record<string, unknown>>): number {
  return Number(rows[0]?.["n"] ?? 0);
}

/**
 * The statement that writes one page: the rows arrive as one `jsonb`
 * parameter expanded by `jsonb_to_recordset`, which casts each value to its
 * column's type (quoted integers and ISO strings included).
 */
export function insertStatement(table: PgTable, rows: Array<Record<string, unknown>>): SQL {
  const columns = columnsOf(table);
  const list = sql.join(
    columns.map((c) => sql.identifier(c.name)),
    sql`, `,
  );
  const record = sql.join(
    columns.map((c) => sql`${sql.identifier(c.name)} ${sql.raw(c.getSQLType())}`),
    sql`, `,
  );
  const input = sql`jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS r(${record})`;
  if (primaryKeyOf(table).length > 0) {
    return sql`
      WITH ins AS (
        INSERT INTO ${table} (${list})
        SELECT ${list} FROM ${input}
        ON CONFLICT DO NOTHING
        RETURNING 1
      )
      SELECT count(*)::int AS n FROM ins
    `;
  }
  // No key to conflict on: skip rows already present column for column, and
  // rows repeated within the page.
  const same = sql.join(
    columns.map(
      (c) =>
        sql`${sql.identifier("x")}.${sql.identifier(c.name)} IS NOT DISTINCT FROM ${sql.identifier("r")}.${sql.identifier(c.name)}`,
    ),
    sql` AND `,
  );
  return sql`
    WITH ins AS (
      INSERT INTO ${table} (${list})
      SELECT ${list} FROM (SELECT DISTINCT * FROM ${input}) AS r
      WHERE NOT EXISTS (SELECT 1 FROM ${table} AS x WHERE ${same})
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM ins
  `;
}

async function destinationCount(db: Db, table: PgTable): Promise<number> {
  const rows = (await db.execute(sql`SELECT count(*)::int AS n FROM ${table}`)) as unknown as Array<
    Record<string, unknown>
  >;
  return countOf(rows);
}

/** Copy (or, on a dry run, only count) every table. */
export async function copyClickHouseToPostgres(options: CopyOptions): Promise<TableCopyResult[]> {
  const { db, source, dryRun = false, pageSize = COPY_PAGE_SIZE } = options;
  const fetchImpl = options.fetch ?? fetch;
  const log = options.log ?? (() => {});
  const specs = options.tables
    ? COPY_TABLES.filter((s) => options.tables!.includes(getTableName(s.table)))
    : COPY_TABLES;

  const results: TableCopyResult[] = [];
  for (const spec of specs) {
    const name = getTableName(spec.table);
    const sourceCount = countOf(await queryClickHouse(source, countQuery(spec), fetchImpl));
    let inserted = 0;
    if (!dryRun) {
      for (let offset = 0; ; offset += pageSize) {
        const page = (
          await queryClickHouse(source, pageQuery(spec, pageSize, offset), fetchImpl)
        ).map(unalias);
        if (page.length > 0) {
          const rows = (await db.execute(insertStatement(spec.table, page))) as unknown as Array<
            Record<string, unknown>
          >;
          inserted += countOf(rows);
          log(`${name}: read ${offset + page.length} of ${sourceCount}, inserted ${inserted}`);
        }
        if (page.length < pageSize) break;
      }
    }
    results.push({
      table: name,
      source: sourceCount,
      inserted,
      destination: await destinationCount(db, spec.table),
    });
  }
  return results;
}

/** The result as a fixed-width table for the terminal. */
export function formatCopyReport(results: readonly TableCopyResult[], dryRun: boolean): string {
  const header = ["table", "source", dryRun ? "inserted (dry run)" : "inserted", "destination"];
  const rows = results.map((r) => [
    r.table,
    String(r.source),
    String(r.inserted),
    String(r.destination),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ");
  const short = results.filter((r) => r.destination < r.source).map((r) => r.table);
  return [
    line(header),
    ...rows.map(line),
    "",
    short.length === 0
      ? "Every table holds at least as many rows as the source."
      : `Fewer rows than the source: ${short.join(", ")}.`,
  ].join("\n");
}

/** The source from the environment; see the script's header for the variables. */
export function sourceFromEnv(env: NodeJS.ProcessEnv): ClickHouseSource {
  const url = env["CLICKHOUSE_URL"];
  if (!url) throw new Error("CLICKHOUSE_URL is required");
  const headers = env["CLICKHOUSE_HEADERS"];
  let parsed: Record<string, string> | undefined;
  if (headers) {
    const value: unknown = JSON.parse(headers);
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !Object.values(value).every((v) => typeof v === "string")
    ) {
      throw new Error("CLICKHOUSE_HEADERS must be a JSON object of strings");
    }
    parsed = value as Record<string, string>;
  }
  return {
    url,
    user: env["CLICKHOUSE_USER"] ?? "default",
    password: env["CLICKHOUSE_PASSWORD"] ?? "",
    database: env["CLICKHOUSE_DATABASE"] ?? "infrawrench",
    ...(parsed ? { headers: parsed } : {}),
  };
}
