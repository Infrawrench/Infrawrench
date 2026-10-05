/**
 * Loading cost export rows into a Snowflake table.
 *
 * ## Why bound INSERTs into a staging table, then one transaction
 *
 * Everything this plugin does goes through the SQL API v2, and the SQL API
 * cannot run `PUT` (docs.snowflake.com/en/developer-guide/sql-api/intro,
 * "Limitations of the SQL API", checked 2026-10), so the bulk-load path a
 * driver would use (PUT to an internal stage, then COPY INTO) is not
 * available. The two remaining options were:
 *
 * 1. **An external stage over a bucket the user already exports to**, then
 *    COPY INTO. Fast, but it needs a storage integration (an ACCOUNTADMIN
 *    task), an IAM trust relationship on the bucket, and an S3 export running
 *    first, all for an org that just wants rows in a table.
 * 2. **Bound multi-row INSERTs.** No setup beyond grants on one schema. The
 *    limits are generous for daily cost rows: query text is recommended to
 *    stay under 1 MB and a VALUES list caps at 16,384 rows
 *    (docs.snowflake.com/en/user-guide/query-size-limits), so batches of
 *    {@link BATCH_ROWS} rows keep each request small; even a large estate's
 *    per-resource day is a few dozen requests.
 *
 * Option 2 is used. Bind variables keep values out of the statement text
 * entirely, so a tag value can never become SQL.
 *
 * ## Why the staging table
 *
 * The SQL API does not support bind variables in a multi-statement request,
 * and an explicit transaction needs a multi-statement request (each request is
 * its own session). So the bound INSERTs cannot run inside the transaction
 * that replaces the period. Instead they fill a transient staging table, and
 * one literal-only multi-statement request does
 * `BEGIN; DELETE <period>; INSERT ... SELECT FROM stage; COMMIT`. A failure
 * while staging leaves the target untouched; the swap itself is atomic. A
 * MERGE was considered and rejected: it cannot remove a row that disappeared
 * from a restated day (a resource whose charge was reversed), and delete then
 * insert can.
 */
import type {
  CredentialFieldOption,
  WarehouseCell,
  WarehouseColumnType,
  WarehouseLoadRequest,
  WarehouseLoadResult,
  WarehouseSetupGuide,
  WarehouseSinkDeclaration,
} from "@infrawrench/plugin-base";
import type { SnowflakeBinding, SnowflakeContext, StatementOptions } from "./api.js";
import { SnowflakeError, ident, literal, qualified, runSql, str } from "./api.js";

export const SNOWFLAKE_WAREHOUSE_SINK: WarehouseSinkDeclaration = {
  label: "Snowflake table",
  description:
    "Load rows into a table in your Snowflake account through the SQL API. The table is created on the first run if it does not exist.",
  targetFields: [
    {
      key: "warehouse",
      label: "Warehouse",
      description: "Runs the load. An X-Small warehouse with auto-suspend is plenty.",
      optional: true,
      emptyLabel: "The account's configured warehouse",
    },
    { key: "database", label: "Database" },
    { key: "schema", label: "Schema", dependsOn: ["database"] },
    {
      key: "table",
      label: "Table",
      description: "Pick an existing table or type a new name; a new table is created.",
      dependsOn: ["database", "schema"],
      allowCustom: true,
      placeholder: "INFRAWRENCH_COSTS",
    },
  ],
};

/** Rows per bound INSERT. Far below the 16,384-row VALUES cap; keeps a request near 1 MB. */
export const BATCH_ROWS = 1_000;
/** Soft cap on bound value bytes per request, for rows with long tag values. */
const BATCH_BYTES = 768 * 1024;

const UNQUOTED = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/**
 * Column names are created upper-case when they are plain identifiers, so they
 * can be queried unquoted (`SELECT AMOUNT FROM ...`), which is how Snowflake
 * users write SQL. Anything else keeps its exact spelling, quoted.
 */
export function snowflakeColumnName(name: string): string {
  return UNQUOTED.test(name) ? name.toUpperCase() : name;
}

/** A table name typed by the user follows the same rule; a picked one is exact already. */
function tableName(name: string): string {
  return UNQUOTED.test(name) ? name.toUpperCase() : name;
}

export function snowflakeType(type: WarehouseColumnType): string {
  switch (type) {
    case "date":
      return "DATE";
    case "timestamp":
      return "TIMESTAMP_TZ";
    case "decimal":
      return "NUMBER(38, 10)";
    case "boolean":
      return "BOOLEAN";
    case "json":
      return "VARIANT";
    default:
      return "VARCHAR";
  }
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

interface ResolvedTarget {
  warehouse: string | undefined;
  database: string;
  schema: string;
  table: string;
}

function resolveTarget(target: Record<string, string>): ResolvedTarget {
  const database = (target["database"] ?? "").trim();
  const schema = (target["schema"] ?? "").trim();
  const table = (target["table"] ?? "").trim();
  if (!database || !schema || !table) {
    throw new Error("Snowflake: choose a database, schema and table for this export.");
  }
  const warehouse = (target["warehouse"] ?? "").trim();
  return { warehouse: warehouse || undefined, database, schema, table: tableName(table) };
}

/** Bind value for one cell. Everything travels as TEXT; the column type does the cast. */
function binding(cell: WarehouseCell, type: WarehouseColumnType): SnowflakeBinding {
  if (cell === null || cell === undefined) return { type: "TEXT", value: null };
  // An empty string is a value in a text column and "no value" in any other.
  if (cell === "") return { type: "TEXT", value: type === "string" ? "" : null };
  if (typeof cell === "number") return { type: "TEXT", value: decimalText(cell) };
  if (typeof cell === "boolean") return { type: "TEXT", value: cell ? "true" : "false" };
  return { type: "TEXT", value: cell };
}

/** A number as plain decimal text: `String(1e-7)` is `1e-7`, which a NUMBER cast accepts but reads poorly. */
export function decimalText(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const s = String(n);
  return /e/i.test(s) ? n.toFixed(10).replace(/\.?0+$/, "") : s;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Transient failures worth a second attempt: throttling, timeouts, a busy
 * warehouse. Only used for idempotent statements (DDL, SHOW).
 */
function isTransient(err: unknown): boolean {
  if (!(err instanceof SnowflakeError)) return false;
  return err.status === 408 || err.status === 429 || err.status >= 500;
}

async function exec(
  ctx: SnowflakeContext,
  statement: string,
  opts: StatementOptions,
  attempts = 3,
): Promise<Awaited<ReturnType<typeof runSql>>> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await runSql(ctx, statement, opts);
    } catch (err) {
      if (attempt >= attempts || !isTransient(err)) throw err;
      await sleep(2_000 * attempt);
    }
  }
}

function friendly(err: unknown, table: string): Error {
  if (!(err instanceof Error)) return new Error(String(err));
  if (err instanceof SnowflakeError && (err.code === "002003" || err.code === "003001")) {
    return new Error(
      `${err.message} The connected role needs USAGE on the warehouse, database and schema, CREATE TABLE on the schema, and SELECT, INSERT and DELETE on ${table}. See the setup statements in the export's settings.`,
    );
  }
  return err;
}

/** Existing column names (as stored) of a table, or null when it does not exist. */
async function existingColumns(
  ctx: SnowflakeContext,
  fq: string,
  opts: StatementOptions,
): Promise<Set<string> | null> {
  try {
    const res = await exec(ctx, `SHOW COLUMNS IN TABLE ${fq}`, opts);
    return new Set(res.rows.map((r) => str(r["column_name"])));
  } catch (err) {
    if (err instanceof SnowflakeError && err.code === "002003") return null;
    throw err;
  }
}

/**
 * Create the target (or add the columns it is missing), stage the rows, and
 * swap the period in one transaction.
 */
export async function loadSnowflakeRows(
  ctx: SnowflakeContext,
  req: WarehouseLoadRequest,
): Promise<WarehouseLoadResult> {
  const target = resolveTarget(req.target);
  const { replace } = req;
  if (!ISO_DAY.test(replace.from) || !ISO_DAY.test(replace.to)) {
    throw new Error("Snowflake: the period bounds must be YYYY-MM-DD dates.");
  }
  const fq = qualified(target.database, target.schema, target.table);
  const display = `${target.database}.${target.schema}.${target.table}`;
  const opts: StatementOptions = {
    ...(target.warehouse ? { warehouse: target.warehouse } : {}),
    timeoutSec: 600,
  };
  const cols = req.columns.map((c) => ({ ...c, sql: ident(snowflakeColumnName(c.name)) }));
  const colList = cols.map((c) => c.sql).join(", ");
  const colDefs = (list: typeof cols) =>
    list.map((c) => `${c.sql} ${snowflakeType(c.type)}`).join(", ");
  const scopeCol = ident(snowflakeColumnName(replace.scopeColumn));
  const dayCol = ident(snowflakeColumnName(replace.dayColumn));

  let stage: string | null = null;
  try {
    const existing = await existingColumns(ctx, fq, opts);
    if (existing === null) {
      await exec(
        ctx,
        `CREATE TABLE IF NOT EXISTS ${fq} (${colDefs(cols)}) COMMENT = 'Cost export rows loaded by Infrawrench'`,
        opts,
      );
    } else {
      for (const c of cols) {
        if (existing.has(snowflakeColumnName(c.name))) continue;
        await exec(
          ctx,
          `ALTER TABLE ${fq} ADD COLUMN IF NOT EXISTS ${c.sql} ${snowflakeType(c.type)}`,
          opts,
        );
      }
    }

    const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase();
    stage = qualified(target.database, target.schema, `${target.table}__IW_STAGE_${suffix}`);
    // Transient: no Fail-safe storage for a table that lives for one run.
    await exec(ctx, `CREATE TRANSIENT TABLE ${stage} (${colDefs(cols)})`, opts);

    let rowCount = 0;
    let batch: WarehouseCell[][] = [];
    let batchBytes = 0;
    const flush = async () => {
      if (batch.length === 0) return;
      const bindings: Record<string, SnowflakeBinding> = {};
      let n = 0;
      for (const row of batch) {
        cols.forEach((c, i) => {
          n++;
          bindings[String(n)] = binding(row[i] ?? null, c.type);
        });
      }
      const tuples = batch.map(() => `(${cols.map(() => "?").join(", ")})`).join(", ");
      // A VARIANT column cannot take a bound string in a plain VALUES list,
      // so a layout with one goes through SELECT ... FROM VALUES and parses
      // the text there. Every other type relies on the implicit cast from
      // the bound text to the column type.
      const statement = cols.some((c) => c.type === "json")
        ? `INSERT INTO ${stage} (${colList}) SELECT ${cols
            .map((c, i) => (c.type === "json" ? `PARSE_JSON($${i + 1})` : `$${i + 1}`))
            .join(", ")} FROM VALUES ${tuples}`
        : `INSERT INTO ${stage} (${colList}) VALUES ${tuples}`;
      // One attempt at this layer: runSql already retries throttling with the
      // same requestId (which Snowflake de-duplicates), and a blind re-send of
      // an INSERT that may have landed would stage its rows twice.
      await exec(ctx, statement, { ...opts, bindings }, 1);
      batch = [];
      batchBytes = 0;
    };

    for await (const row of req.rows) {
      batch.push(row);
      rowCount++;
      for (const cell of row) batchBytes += typeof cell === "string" ? cell.length + 32 : 40;
      if (batch.length >= BATCH_ROWS || batchBytes >= BATCH_BYTES) await flush();
    }
    await flush();

    // Literal-only, because bindings are not allowed in a multi-statement
    // request. Every interpolated value is either a quoted identifier, a
    // validated ISO date, or the scope value through `literal`.
    const swap = [
      "BEGIN",
      `DELETE FROM ${fq} WHERE ${scopeCol} = ${literal(replace.scopeValue)} AND ${dayCol} BETWEEN ${literal(replace.from)}::DATE AND ${literal(replace.to)}::DATE`,
      `INSERT INTO ${fq} (${colList}) SELECT ${colList} FROM ${stage}`,
      "COMMIT",
    ].join(";\n");
    await exec(ctx, swap, { ...opts, multiStatementCount: 4 }, 1);
    return { rowCount, table: display };
  } catch (err) {
    throw friendly(err, display);
  } finally {
    if (stage) {
      await runSql(ctx, `DROP TABLE IF EXISTS ${stage}`, opts).catch(() => {});
    }
  }
}

/** Options for one target field. SHOW commands only: none of them resumes a warehouse. */
export async function listSnowflakeTargetOptions(
  ctx: SnowflakeContext,
  fieldKey: string,
  target: Record<string, string>,
): Promise<CredentialFieldOption[]> {
  const database = (target["database"] ?? "").trim();
  const schema = (target["schema"] ?? "").trim();
  switch (fieldKey) {
    case "warehouse": {
      const res = await runSql(ctx, "SHOW WAREHOUSES");
      return res.rows.map((w) => ({
        id: str(w["name"]),
        label: str(w["name"]),
        description: `${str(w["size"])}, ${str(w["state"]).toLowerCase()}`,
      }));
    }
    case "database": {
      const res = await runSql(ctx, "SHOW DATABASES");
      return res.rows
        .filter((d) => str(d["kind"]).toUpperCase() !== "APPLICATION")
        .filter((d) => !["SNOWFLAKE", "SNOWFLAKE_SAMPLE_DATA"].includes(str(d["name"])))
        .map((d) => ({ id: str(d["name"]), label: str(d["name"]) }));
    }
    case "schema": {
      if (!database) return [];
      const res = await runSql(ctx, `SHOW SCHEMAS IN DATABASE ${ident(database)}`);
      return res.rows
        .filter((r) => str(r["name"]).toUpperCase() !== "INFORMATION_SCHEMA")
        .map((r) => ({ id: str(r["name"]), label: str(r["name"]) }));
    }
    case "table": {
      if (!database || !schema) return [];
      const res = await runSql(ctx, `SHOW TABLES IN SCHEMA ${qualified(database, schema)}`);
      return res.rows
        .filter((r) => !/__IW_STAGE_/.test(str(r["name"])))
        .map((r) => ({
          id: str(r["name"]),
          label: str(r["name"]),
          ...(r["rows"] !== null && r["rows"] !== undefined
            ? { description: `${str(r["rows"])} rows` }
            : {}),
        }));
    }
    default:
      return [];
  }
}

/** The grants a load needs, for the role this account connects as. */
export function snowflakeSetupGuide(
  target: Record<string, string>,
  role: string,
  user: string,
): WarehouseSetupGuide {
  const database = (target["database"] ?? "").trim() || "<DATABASE>";
  const schema = (target["schema"] ?? "").trim() || "<SCHEMA>";
  const rawTable = (target["table"] ?? "").trim();
  const table = rawTable ? tableName(rawTable) : "<TABLE>";
  const warehouse = (target["warehouse"] ?? "").trim();
  const r = role ? ident(role) : "<ROLE>";
  const lines = [
    "-- Run as a role that can grant on these objects (the schema owner, or SECURITYADMIN).",
    `-- Grants for ${role ? `role ${role}` : "the role this account connects as"}${user ? ` (user ${user})` : ""}.`,
    warehouse
      ? `GRANT USAGE ON WAREHOUSE ${ident(warehouse)} TO ROLE ${r};`
      : "-- GRANT USAGE ON WAREHOUSE <WAREHOUSE> TO ROLE ... (the warehouse the account is configured with)",
    `GRANT USAGE ON DATABASE ${ident(database)} TO ROLE ${r};`,
    `GRANT USAGE ON SCHEMA ${qualified(database, schema)} TO ROLE ${r};`,
    "-- Creates the table on the first run, and a short-lived staging table on every run.",
    `GRANT CREATE TABLE ON SCHEMA ${qualified(database, schema)} TO ROLE ${r};`,
    "-- Only if the table already exists and another role owns it:",
    `GRANT SELECT, INSERT, DELETE ON TABLE ${qualified(database, schema, table)} TO ROLE ${r};`,
  ];
  if (!role) {
    lines.splice(
      1,
      0,
      "-- The account has no role set, so statements run as the user's default role; replace <ROLE> with it.",
    );
  }
  return {
    sql: lines.join("\n"),
    notes: [
      "Loading uses the connected account's credentials; nothing else is stored on the export.",
      "Each run replaces the rows for the periods it exports (matched on EXPORT_ID and DAY) in one transaction, so re-runs and restatements never duplicate rows.",
    ],
  };
}
