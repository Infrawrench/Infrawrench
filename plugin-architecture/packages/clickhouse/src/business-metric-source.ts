/**
 * ClickHouse as a business-metric source: a scheduled query against the
 * service whose HTTPS endpoint the account is configured with (`chHost`,
 * `chUser`, `chPassword`; the same connection `executeQuery` and the SQL
 * editor use). The Cloud API key cannot run SQL, so a service picker would
 * offer services the stored database password does not belong to; the source
 * therefore always queries the configured service and says so on the form.
 *
 * Read-only is enforced by ClickHouse: every query carries `readonly=1`, which
 * refuses anything but read queries and also stops the query's own SETTINGS
 * clause from loosening the bounds sent with it (`max_result_rows` with
 * `result_overflow_mode=throw`, `max_execution_time` with
 * `timeout_overflow_mode=throw`). Settings in one HTTP request are checked as
 * a batch against the user's profile before any is applied, so `readonly=1`
 * and the bounds travel together. If the SQL user's profile is already
 * read-only, ClickHouse refuses setting changes; the run then reads the
 * profile's own `readonly` value and retries with fewer settings only when it
 * is non-zero, so the session is read-only either way.
 *
 * References: https://clickhouse.com/docs/operations/settings/permissions-for-queries
 * (readonly), https://clickhouse.com/docs/interfaces/http (settings as URL
 * parameters, `database`), and the setting declarations in ClickHouse's
 * src/Core/Settings.cpp (max_result_rows, result_overflow_mode,
 * max_execution_time, session_timezone).
 */
import type {
  ClickHouseClient as ClickHouseSdkClient,
  ClickHouseSettings,
} from "@clickhouse/client-web";
import {
  assertBusinessMetricSql,
  bindBusinessMetricSqlRange,
  rowsToBusinessMetricPoints,
  withBusinessMetricTimeout,
  type BusinessMetricSourceDeclaration,
  type BusinessMetricSourceOption,
  type BusinessMetricSourceRange,
  type BusinessMetricSourceResult,
} from "@infrawrench/plugin-base";

export const clickhouseBusinessMetricSource: BusinessMetricSourceDeclaration = {
  label: "ClickHouse SQL",
  description:
    "Run a ClickHouse SQL query on a schedule against the service this account connects to for SQL. It must return one row per day with a `day` and a `value` column, plus an optional `label` column for a breakdown.",
  kind: "sql",
  sqlDialect: "ClickHouse SQL",
  readOnly: "enforced",
  fields: [
    {
      key: "database",
      label: "Database",
      type: "select",
      description:
        "Optional default database: unqualified table names resolve here. The query runs on the service set as the account's SQL hostname.",
    },
    {
      key: "sql",
      label: "Query",
      type: "sql",
      required: true,
      description:
        "A single SELECT returning `day`, `value` and optionally `label`. {{from}}, {{to}}, {{to_exclusive}} and {{timezone}} are replaced with quoted values for the import window. The session timezone is the importer's timezone, so toDate() on a DateTime gives local days. Runs with readonly=1.",
      placeholder:
        "SELECT toDate(created_at) AS day, uniqExact(customer_id) AS value\nFROM orders\nWHERE toDate(created_at) BETWEEN {{from}} AND {{to}}\nGROUP BY day\nORDER BY day",
    },
  ],
};

export interface ClickHouseMetricContext {
  /** An SDK client for the configured service, or null when the account has no SQL endpoint. */
  makeClient(opts: { database?: string; requestTimeoutMs: number }): ClickHouseSdkClient | null;
}

const NO_SQL_ENDPOINT =
  "This account has no SQL connection. Edit the account and fill in the service hostname, SQL user and SQL password, then try again.";

/** Databases ClickHouse creates for itself; never a business metric's home. */
const SYSTEM_DATABASES = ["system", "INFORMATION_SCHEMA", "information_schema"];

/** ClickHouse's READONLY (164): the profile is read-only and refuses setting changes. */
function isReadonlySettingRefusal(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return (
    code === "164" ||
    (err as { type?: unknown }).type === "READONLY" ||
    /setting in readonly mode/i.test(err.message)
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function wrapQueryError(err: unknown, maxRows: number): Error {
  const message = errorText(err);
  if (/Limit for result exceeded|TOO_MANY_ROWS_OR_BYTES/i.test(message)) {
    return new Error(
      `The query returned more than ${maxRows} rows. Group by day in the query so it returns one row per day (and label).`,
      { cause: err },
    );
  }
  return new Error(`ClickHouse query failed: ${message}`, { cause: err });
}

export async function listClickHouseBusinessMetricOptions(
  ctx: ClickHouseMetricContext,
  fieldKey: string,
  _params: Record<string, string>,
): Promise<BusinessMetricSourceOption[]> {
  if (fieldKey !== "database") return [];
  const client = ctx.makeClient({ requestTimeoutMs: 30_000 });
  if (!client) throw new Error(NO_SQL_ENDPOINT);
  try {
    const result = await client.query({
      query: "SELECT name, engine, comment FROM system.databases ORDER BY name",
      format: "JSONEachRow",
    });
    const rows = await result.json<{ name?: string; engine?: string; comment?: string }>();
    return rows
      .filter((r) => r.name && !SYSTEM_DATABASES.includes(r.name))
      .map((r) => ({
        id: r.name!,
        label: r.name!,
        ...(r.comment ? { description: r.comment } : r.engine ? { description: r.engine } : {}),
      }));
  } catch (err) {
    throw new Error(`ClickHouse query failed: ${errorText(err)}`, { cause: err });
  } finally {
    await client.close();
  }
}

export async function runClickHouseBusinessMetricSource(
  ctx: ClickHouseMetricContext,
  params: Record<string, string>,
  range: BusinessMetricSourceRange,
): Promise<BusinessMetricSourceResult> {
  const raw = params["sql"] ?? "";
  // On every execution, not only when the importer was saved.
  assertBusinessMetricSql(raw);
  const query = bindBusinessMetricSqlRange(raw, range);
  const database = params["database"]?.trim() ?? "";
  const client = ctx.makeClient({
    ...(database ? { database } : {}),
    // The HTTP request outlives max_execution_time slightly so ClickHouse's
    // own timeout error arrives instead of a bare socket abort.
    requestTimeoutMs: range.timeoutMs + 5_000,
  });
  if (!client) throw new Error(NO_SQL_ENDPOINT);

  const bounds = {
    max_result_rows: String(range.maxRows),
    result_overflow_mode: "throw" as const,
    max_execution_time: Math.max(1, Math.ceil(range.timeoutMs / 1000)),
    timeout_overflow_mode: "throw" as const,
    session_timezone: range.timezone,
  };
  const strict = { readonly: "1", ...bounds };

  const attempt = async (settings: ClickHouseSettings) => {
    const result = await client.query({
      query,
      format: "JSONEachRow",
      clickhouse_settings: settings,
      ...(range.signal ? { abort_signal: range.signal } : {}),
    });
    const rows = await result.json<Record<string, unknown>>();
    return { rows, summary: readSummary(result.response_headers?.["x-clickhouse-summary"]) };
  };

  /**
   * The SQL user's profile `readonly` value, asked without sending any
   * setting. Only consulted after a READONLY refusal, to tell "the profile is
   * already read-only" (safe to retry with fewer settings) from "the query's
   * own SETTINGS clause was refused under readonly=1" (never retried).
   */
  const profileReadonly = async (): Promise<string> => {
    const result = await client.query({
      query: "SELECT toString(getSetting('readonly')) AS ro",
      format: "JSONEachRow",
      ...(range.signal ? { abort_signal: range.signal } : {}),
    });
    const [row] = await result.json<{ ro?: string }>();
    return String(row?.ro ?? "0");
  };

  const fetchRows = async () => {
    try {
      return { ...(await attempt(strict)), viaProfile: false };
    } catch (err) {
      if (!isReadonlySettingRefusal(err)) throw wrapQueryError(err, range.maxRows);
      const profile = await profileReadonly().catch(() => "0");
      // readonly=2 refuses a change to `readonly` but takes the bounds;
      // readonly=1 refuses every change. Either way the profile keeps the
      // session read-only. readonly=0 means the refusal came from the query.
      if (profile === "0") throw wrapQueryError(err, range.maxRows);
      try {
        return { ...(await attempt(profile === "1" ? {} : bounds)), viaProfile: true };
      } catch (retryErr) {
        throw wrapQueryError(retryErr, range.maxRows);
      }
    }
  };

  const run = async (): Promise<BusinessMetricSourceResult> => {
    const { rows, summary, viaProfile } = await fetchRows();
    // Also checked here: the fallback attempts cannot bound rows server-side.
    const points = rowsToBusinessMetricPoints(rows, range.maxRows);
    const notes = [`${rows.length} row${rows.length === 1 ? "" : "s"}`];
    if (summary) notes.push(summary);
    if (viaProfile) notes.push("Read-only through the SQL user's profile");
    return { points, notes };
  };

  try {
    return await withBusinessMetricTimeout(run(), range);
  } finally {
    await client.close();
  }
}

/** "Read 1.2M rows, 340 MB" from the X-ClickHouse-Summary header, when present. */
function readSummary(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return null;
  try {
    const summary = JSON.parse(raw) as { read_rows?: string; read_bytes?: string };
    const rows = Number(summary.read_rows);
    const bytes = Number(summary.read_bytes);
    if (!Number.isFinite(rows) || !Number.isFinite(bytes)) return null;
    return `Read ${compact(rows)} rows, ${formatBytes(bytes)}`;
  } catch {
    return null;
  }
}

function compact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}
