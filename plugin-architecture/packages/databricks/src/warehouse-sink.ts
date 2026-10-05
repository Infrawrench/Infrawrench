/**
 * Loading cost export rows into a Unity Catalog table.
 *
 * ## Why batched INSERTs into a staging table, then `INSERT ... REPLACE WHERE`
 *
 * Two routes were available (checked against docs.databricks.com, 2026-10):
 *
 * 1. **Upload a file to a UC volume (Files API), then `COPY INTO`.** Fast for
 *    very large loads, but it needs a volume, `READ VOLUME`/`WRITE VOLUME`
 *    grants and a third picker, and `COPY INTO` is idempotent *per file name*:
 *    re-loading a restated period means forcing it, which then has to be
 *    paired with a delete anyway.
 * 2. **The SQL Statement Execution API** (`POST /api/2.0/sql/statements`) on a
 *    SQL warehouse the user picks. Statement text may be up to 16 MiB. Named
 *    parameter markers would keep values out of the text, but a statement
 *    accepts at most 256 parameters (an undocumented limit the API enforces),
 *    which is a dozen rows; so values are written as escaped literals instead.
 *
 * Route 2 is used: one warehouse picker, grants on one schema, and no files
 * left behind. Rows go into a per-run staging table in batches of up to
 * {@link BATCH_BYTES}, then one `INSERT INTO target REPLACE WHERE <period>
 * SELECT ... FROM stage` swaps the period atomically: Delta deletes the
 * matching rows and inserts the new ones in a single commit, and fails without
 * writing anything if a row falls outside the predicate. The API runs one
 * statement per call and has no multi-statement transactions, which is exactly
 * why the single-statement `REPLACE WHERE` is the right primitive here.
 *
 * String literals use backslash escapes: Databricks SQL does not treat `''` as
 * an escaped quote (two adjacent literals concatenate instead), so the usual
 * ANSI escaping would silently corrupt a value containing an apostrophe.
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

export type ApiFn = <T>(method: string, path: string, body?: Record<string, unknown>) => Promise<T>;

export const DATABRICKS_WAREHOUSE_SINK: WarehouseSinkDeclaration = {
  label: "Databricks table",
  description:
    "Load rows into a Unity Catalog table through a SQL warehouse. The table is created as a Delta table on the first run if it does not exist.",
  targetFields: [
    {
      key: "warehouseId",
      label: "SQL warehouse",
      description: "Runs the load. A small serverless warehouse is plenty.",
    },
    { key: "catalog", label: "Catalog" },
    { key: "schema", label: "Schema", dependsOn: ["catalog"] },
    {
      key: "table",
      label: "Table",
      description: "Pick an existing table or type a new name; a new Delta table is created.",
      dependsOn: ["catalog", "schema"],
      allowCustom: true,
      placeholder: "infrawrench_costs",
    },
  ],
};

/** Statement text budget per staging INSERT; well under the 16 MiB limit. */
export const BATCH_BYTES = 2 * 1024 * 1024;
const BATCH_ROWS = 5_000;
const POLL_LIMIT_MS = 15 * 60_000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const WAREHOUSE_ID = /^[A-Za-z0-9]+$/;

export function databricksType(type: WarehouseColumnType): string {
  switch (type) {
    case "date":
      return "DATE";
    case "timestamp":
      return "TIMESTAMP";
    case "decimal":
      return "DECIMAL(38, 10)";
    case "boolean":
      return "BOOLEAN";
    // JSON text in a STRING column: VARIANT needs a recent runtime, and
    // `parse_json`/`from_json` read either.
    default:
      return "STRING";
  }
}

/** Backtick-quoted identifier, embedded backticks doubled. */
export function quoteIdent(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

/** Single-quoted literal with backslash escaping, the only escaping Databricks SQL honours. */
export function stringLiteral(value: string): string {
  return `'${value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")}'`;
}

function decimalText(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const s = String(n);
  return /e/i.test(s) ? n.toFixed(10).replace(/\.?0+$/, "") : s;
}

/** One cell as a SQL literal of the column's type. */
export function cellLiteral(cell: WarehouseCell, type: WarehouseColumnType): string {
  if (cell === null || cell === undefined) return "NULL";
  if (cell === "" && type !== "string" && type !== "json") return "NULL";
  switch (type) {
    case "decimal": {
      const n = typeof cell === "number" ? cell : Number(cell);
      return Number.isFinite(n) ? decimalText(n) : "NULL";
    }
    case "boolean":
      return cell === true || cell === "true" ? "TRUE" : "FALSE";
    case "date":
      return ISO_DAY.test(String(cell)) ? `DATE${stringLiteral(String(cell))}` : "NULL";
    case "timestamp":
      return `TIMESTAMP${stringLiteral(String(cell))}`;
    default:
      return stringLiteral(String(cell));
  }
}

interface StatementResponse {
  statement_id?: string;
  status?: { state?: string; error?: { message?: string; error_code?: string } };
}

interface ResolvedTarget {
  warehouseId: string;
  catalog: string;
  schema: string;
  table: string;
}

function resolveTarget(target: Record<string, string>): ResolvedTarget {
  const warehouseId = (target["warehouseId"] ?? "").trim();
  const catalog = (target["catalog"] ?? "").trim();
  const schema = (target["schema"] ?? "").trim();
  const table = (target["table"] ?? "").trim();
  if (!warehouseId || !WAREHOUSE_ID.test(warehouseId)) {
    throw new Error("Databricks: choose the SQL warehouse that runs this export.");
  }
  if (!catalog || !schema || !table) {
    throw new Error("Databricks: choose a catalog, schema and table for this export.");
  }
  return { warehouseId, catalog, schema, table };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The HTTP status the client's error message carries, if any. */
function statusOf(err: unknown): number | null {
  const m = err instanceof Error ? /failed: (\d{3})\b/.exec(err.message) : null;
  return m ? Number(m[1]) : null;
}

/**
 * Run one statement to completion: wait up to 50s inline, then poll. A 429 is
 * re-sent (the statement was not accepted); nothing else is, because a re-sent
 * INSERT that had in fact landed would stage its rows twice.
 */
export async function runDatabricksStatement(
  api: ApiFn,
  warehouseId: string,
  statement: string,
): Promise<void> {
  let res: StatementResponse | undefined;
  for (let attempt = 1; ; attempt++) {
    try {
      res = await api<StatementResponse>("POST", "/api/2.0/sql/statements", {
        warehouse_id: warehouseId,
        statement,
        wait_timeout: "50s",
        on_wait_timeout: "CONTINUE",
        disposition: "INLINE",
        format: "JSON_ARRAY",
      });
      break;
    } catch (err) {
      if (statusOf(err) !== 429 || attempt >= 4) throw err;
      await sleep(2_000 * 2 ** (attempt - 1));
    }
  }
  let state = res.status?.state ?? "FAILED";
  const started = Date.now();
  while (state === "PENDING" || state === "RUNNING") {
    if (!res.statement_id) throw new Error("Databricks: statement accepted without an id.");
    if (Date.now() - started > POLL_LIMIT_MS) {
      await api("POST", `/api/2.0/sql/statements/${res.statement_id}/cancel`).catch(() => {});
      throw new Error("Databricks: gave up waiting for the statement to finish.");
    }
    await sleep(2_000);
    res = await api<StatementResponse>("GET", `/api/2.0/sql/statements/${res.statement_id}`);
    state = res.status?.state ?? "FAILED";
  }
  if (state !== "SUCCEEDED") {
    throw new Error(`Databricks: ${res.status?.error?.message ?? `statement ended ${state}`}`);
  }
}

interface TableColumn {
  name: string;
  typeText: string;
}

/** Columns of a UC table in position order, or null when the table does not exist. */
async function tableColumns(api: ApiFn, fullName: string): Promise<TableColumn[] | null> {
  try {
    const t = await api<{
      columns?: Array<{ name?: string; type_text?: string; position?: number }>;
    }>("GET", `/api/2.1/unity-catalog/tables/${encodeURIComponent(fullName)}`);
    return (t.columns ?? [])
      .slice()
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .map((c) => ({ name: String(c.name ?? ""), typeText: String(c.type_text ?? "string") }));
  } catch (err) {
    if (statusOf(err) === 404 || /TABLE_DOES_NOT_EXIST|NOT_FOUND/.test(String(err))) return null;
    throw err;
  }
}

function friendly(err: unknown, table: string): Error {
  const e = err instanceof Error ? err : new Error(String(err));
  if (/PERMISSION_DENIED|INSUFFICIENT_PERMISSIONS|User does not have/i.test(e.message)) {
    return new Error(
      `${e.message} The connected principal needs USE CATALOG, USE SCHEMA and CREATE TABLE on the schema, SELECT and MODIFY on ${table}, and CAN USE on the SQL warehouse. See the setup statements in the export's settings.`,
    );
  }
  return e;
}

export async function loadDatabricksRows(
  api: ApiFn,
  req: WarehouseLoadRequest,
): Promise<WarehouseLoadResult> {
  const target = resolveTarget(req.target);
  const { replace } = req;
  if (!ISO_DAY.test(replace.from) || !ISO_DAY.test(replace.to)) {
    throw new Error("Databricks: the period bounds must be YYYY-MM-DD dates.");
  }
  const fullName = `${target.catalog}.${target.schema}.${target.table}`;
  const fq = [target.catalog, target.schema, target.table].map(quoteIdent).join(".");
  const run = (sql: string) => runDatabricksStatement(api, target.warehouseId, sql);
  const cols = req.columns.map((c) => ({ ...c, sql: quoteIdent(c.name) }));
  const colDefs = cols.map((c) => `${c.sql} ${databricksType(c.type)}`).join(", ");
  const colList = cols.map((c) => c.sql).join(", ");

  let stage: string | null = null;
  try {
    let existing = await tableColumns(api, fullName);
    if (existing === null) {
      await run(
        `CREATE TABLE IF NOT EXISTS ${fq} (${colDefs}) USING DELTA COMMENT 'Cost export rows loaded by Infrawrench'`,
      );
    } else {
      const have = new Set(existing.map((c) => c.name.toLowerCase()));
      const missing = cols.filter((c) => !have.has(c.name.toLowerCase()));
      if (missing.length > 0) {
        await run(
          `ALTER TABLE ${fq} ADD COLUMNS (${missing.map((c) => `${c.sql} ${databricksType(c.type)}`).join(", ")})`,
        );
      }
    }
    existing = (await tableColumns(api, fullName)) ?? [];

    const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    stage = [target.catalog, target.schema, `${target.table}__iw_stage_${suffix}`]
      .map(quoteIdent)
      .join(".");
    await run(`CREATE TABLE ${stage} (${colDefs}) USING DELTA`);

    const prefix = `INSERT INTO ${stage} (${colList}) VALUES `;
    let rowCount = 0;
    let tuples: string[] = [];
    let bytes = prefix.length;
    const flush = async () => {
      if (tuples.length === 0) return;
      await run(prefix + tuples.join(", "));
      tuples = [];
      bytes = prefix.length;
    };
    for await (const row of req.rows) {
      const tuple = `(${cols.map((c, i) => cellLiteral(row[i] ?? null, c.type)).join(", ")})`;
      if (bytes + tuple.length > BATCH_BYTES) await flush();
      tuples.push(tuple);
      bytes += tuple.length + 2;
      rowCount++;
      if (tuples.length >= BATCH_ROWS) await flush();
    }
    await flush();

    // REPLACE WHERE takes no column list before runtime 19.3, so the SELECT
    // produces the target's columns in its own order, NULL for the ones this
    // export does not write (another export's dimensions, or the user's own).
    const ours = new Map(cols.map((c) => [c.name.toLowerCase(), c.sql]));
    const select = existing
      .map((c) => ours.get(c.name.toLowerCase()) ?? `CAST(NULL AS ${c.typeText})`)
      .join(", ");
    const scope = quoteIdent(replace.scopeColumn);
    const day = quoteIdent(replace.dayColumn);
    await run(
      `INSERT INTO ${fq} REPLACE WHERE ${scope} = ${stringLiteral(replace.scopeValue)} AND ${day} >= DATE'${replace.from}' AND ${day} <= DATE'${replace.to}' SELECT ${select} FROM ${stage}`,
    );
    return { rowCount, table: fullName };
  } catch (err) {
    throw friendly(err, fullName);
  } finally {
    if (stage) await run(`DROP TABLE IF EXISTS ${stage}`).catch(() => {});
  }
}

async function paginate(api: ApiFn, path: string, key: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let token = "";
  for (let page = 0; page < 50; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const data = await api<Record<string, unknown>>(
      "GET",
      token ? `${path}${sep}page_token=${encodeURIComponent(token)}` : path,
    );
    out.push(...((data[key] as Record<string, unknown>[] | undefined) ?? []));
    token = String(data["next_page_token"] ?? "");
    if (!token) break;
  }
  return out;
}

export async function listDatabricksTargetOptions(
  api: ApiFn,
  fieldKey: string,
  target: Record<string, string>,
): Promise<CredentialFieldOption[]> {
  const catalog = (target["catalog"] ?? "").trim();
  const schema = (target["schema"] ?? "").trim();
  switch (fieldKey) {
    case "warehouseId": {
      const data = await api<{
        warehouses?: Array<{
          id?: string;
          name?: string;
          cluster_size?: string;
          state?: string;
          enable_serverless_compute?: boolean;
        }>;
      }>("GET", "/api/2.0/sql/warehouses");
      return (data.warehouses ?? []).map((w) => ({
        id: String(w.id ?? ""),
        label: String(w.name ?? w.id ?? ""),
        description: [
          w.enable_serverless_compute ? "Serverless" : null,
          w.cluster_size,
          w.state?.toLowerCase(),
        ]
          .filter(Boolean)
          .join(", "),
      }));
    }
    case "catalog": {
      const rows = await paginate(api, "/api/2.1/unity-catalog/catalogs?max_results=0", "catalogs");
      return rows
        .filter((c) => !["system", "samples", "__databricks_internal"].includes(String(c["name"])))
        .map((c) => ({ id: String(c["name"] ?? ""), label: String(c["name"] ?? "") }));
    }
    case "schema": {
      if (!catalog) return [];
      const rows = await paginate(
        api,
        `/api/2.1/unity-catalog/schemas?catalog_name=${encodeURIComponent(catalog)}&max_results=0`,
        "schemas",
      );
      return rows
        .filter((s) => String(s["name"]) !== "information_schema")
        .map((s) => ({ id: String(s["name"] ?? ""), label: String(s["name"] ?? "") }));
    }
    case "table": {
      if (!catalog || !schema) return [];
      const rows = await paginate(
        api,
        `/api/2.1/unity-catalog/tables?catalog_name=${encodeURIComponent(catalog)}&schema_name=${encodeURIComponent(schema)}&max_results=0&omit_columns=true`,
        "tables",
      );
      return rows
        .filter((t) => !/__iw_stage_/.test(String(t["name"])))
        .map((t) => ({
          id: String(t["name"] ?? ""),
          label: String(t["name"] ?? ""),
          ...(t["table_type"] ? { description: String(t["table_type"]).toLowerCase() } : {}),
        }));
    }
    default:
      return [];
  }
}

export function databricksSetupGuide(
  target: Record<string, string>,
  principal: string,
): WarehouseSetupGuide {
  const catalog = (target["catalog"] ?? "").trim() || "<catalog>";
  const schema = (target["schema"] ?? "").trim() || "<schema>";
  const table = (target["table"] ?? "").trim() || "<table>";
  const who = quoteIdent(principal || "<principal>");
  const sql = [
    "-- Run as the schema owner or a metastore admin.",
    `-- Grants for ${principal || "the user or service principal that owns the access token"}.`,
    `GRANT USE CATALOG ON CATALOG ${quoteIdent(catalog)} TO ${who};`,
    "-- CREATE TABLE creates the table on the first run, and a short-lived staging table on every run.",
    `GRANT USE SCHEMA, CREATE TABLE ON SCHEMA ${quoteIdent(catalog)}.${quoteIdent(schema)} TO ${who};`,
    "-- Only if the table already exists and someone else owns it:",
    `GRANT SELECT, MODIFY ON TABLE ${[catalog, schema, table].map(quoteIdent).join(".")} TO ${who};`,
  ].join("\n");
  return {
    sql,
    notes: [
      "Also give the same principal the CAN USE permission on the SQL warehouse (SQL Warehouses, the warehouse, Permissions).",
      "Each run replaces the rows for the periods it exports (matched on export_id and day) in a single Delta commit, so re-runs and restatements never duplicate rows.",
    ],
  };
}

/** The token owner's name for GRANT statements, or "" when it cannot be read. */
export async function databricksPrincipal(api: ApiFn): Promise<string> {
  try {
    const me = await api<{ userName?: string; applicationId?: string; displayName?: string }>(
      "GET",
      "/api/2.0/preview/scim/v2/Me",
    );
    return me.userName ?? me.applicationId ?? "";
  } catch {
    return "";
  }
}
