/**
 * Business-metric source contract.
 *
 * A business metric is the denominator a unit cost divides by: customers,
 * requests, GB processed, revenue. The host stores one value per day per
 * metric. Values can always be pushed (API, workflow, CSV), and a plugin that
 * declares `manifest.businessMetricSource` can also be *pulled from* on a
 * schedule: the host asks it for the daily values over a date range and
 * restates those days.
 *
 * The plugin owns everything provider-specific: what the form asks for
 * (`fields`), where each picker's choices come from
 * (`listBusinessMetricSourceOptions`), how a query runs and how its answer
 * becomes days (`runBusinessMetricSource`). The host owns the schedule, the
 * day window, the aggregation of several points into one day, the storage and
 * the run history, and it never learns what a CloudWatch namespace or a
 * BigQuery dataset is.
 *
 * Three rules every implementation keeps:
 *
 * 1. **Read only.** The query runs unattended, on a schedule, with the
 *    account's credentials. SQL sources enforce read-only access where the
 *    engine allows it (a read-only transaction, a `readonly` setting, a dry
 *    run that checks the statement type) and run {@link businessMetricSqlProblem}
 *    on every execution regardless, not only when the importer is saved.
 * 2. **Bounded.** Honour `range.maxRows` and `range.timeoutMs`, and throw
 *    rather than return a short answer: the host restates exactly the days a
 *    run returns, so a silently truncated result reads as smaller numbers,
 *    not as a failure.
 * 3. **Days are local to `range.timezone`.** A point's `date` is the calendar
 *    day in the importer's timezone, which is what the host stores.
 */

/** One input on the importer form, rendered generically by every host. */
export interface BusinessMetricSourceField {
  /** Key in the importer's `params` map. */
  key: string;
  label: string;
  /**
   * - `select`: a picker. Choices come from `options` when static, otherwise
   *   from `PluginClient.listBusinessMetricSourceOptions(fieldKey, params)`.
   * - `sql`: a multi-line SQL editor.
   * - `text` / `number`: a single-line input.
   */
  type: "select" | "sql" | "text" | "number";
  required?: boolean;
  description?: string;
  placeholder?: string;
  /** Pre-filled on a new importer. */
  defaultValue?: string;
  /** Static choices for a `select`; when present no provider call is made. */
  options?: BusinessMetricSourceOption[];
  /**
   * Fields whose values this picker's choices depend on (a metric list depends
   * on the namespace). The host reloads the choices when any of them changes
   * and does not ask before all of them are set.
   */
  dependsOn?: string[];
  /**
   * Accept a typed value that is not among the choices: dimension values are
   * the usual case, where the provider can only list the ones it has seen
   * recently.
   */
  allowCustom?: boolean;
}

/** One choice in a `select` field. */
export interface BusinessMetricSourceOption {
  /** Stored in `params[field.key]` when picked. */
  id: string;
  label: string;
  description?: string;
}

/** Declares that this plugin's accounts can feed a business metric. */
export interface BusinessMetricSourceDeclaration {
  /** What the source is called in the picker: "CloudWatch metric", "BigQuery SQL". */
  label: string;
  description?: string;
  /**
   * `sql`: the form carries a SQL statement whose result rows are the days
   * (columns `day`, `value`, optional `label`; see
   * {@link rowsToBusinessMetricPoints}). `metric`: the form picks a series
   * from the provider's catalog.
   */
  kind: "sql" | "metric";
  /** The form, in display order. */
  fields: BusinessMetricSourceField[];
  /** Shown beside the SQL editor: "PostgreSQL", "GoogleSQL", "ClickHouse SQL". */
  sqlDialect?: string;
  /**
   * How read-only access is guaranteed, which the importer form states plainly:
   * `enforced` means the engine itself refuses a write; `validated` means the
   * statement is checked by {@link businessMetricSqlProblem} and the account's
   * own grants are the only other line of defence.
   */
  readOnly?: "enforced" | "validated";
  /** True when `dryRunBusinessMetricSource` is implemented. */
  supportsDryRun?: boolean;
}

/** The window one run covers, plus the bounds the host enforces. */
export interface BusinessMetricSourceRange {
  /** First day, inclusive, YYYY-MM-DD in `timezone`. */
  from: string;
  /** Last day, inclusive, YYYY-MM-DD in `timezone`. */
  to: string;
  /** IANA timezone the days are counted in, e.g. "UTC", "America/New_York". */
  timezone: string;
  /** Throw when the source would return more rows or points than this. */
  maxRows: number;
  /** Abort the provider call and throw past this many milliseconds. */
  timeoutMs: number;
  /** Aborted when the host gives up on the run (timeout, shutdown). */
  signal?: AbortSignal;
}

/** One raw point. Several per day (or per day and label) are allowed; the host aggregates. */
export interface BusinessMetricSourcePoint {
  /** YYYY-MM-DD in the range's timezone. */
  date: string;
  value: number;
  /** Optional breakdown label; the day's total is the sum across labels. */
  label?: string;
}

export interface BusinessMetricSourceResult {
  points: BusinessMetricSourcePoint[];
  /** Short facts about the run for the history: "Scanned 1.2 GB". */
  notes?: string[];
}

/** What a dry run learned without reading data. */
export interface BusinessMetricSourceDryRun {
  /** False when the provider rejected the query; `message` says why. */
  valid: boolean;
  message: string;
  /** Bytes the query would scan, when the provider says. */
  bytesProcessed?: number;
}

/** Bounds the host passes to every run, and which every client also enforces locally. */
export const BUSINESS_METRIC_SOURCE_LIMITS = {
  /** Rows (SQL) or datapoints (metric sources) one run may return. */
  maxRows: 50_000,
  /** One run's provider budget. */
  timeoutMs: 120_000,
  /** The widest window one run may read. */
  maxDays: 730,
  /** Longest SQL statement an importer stores. */
  maxSqlLength: 20_000,
  /** Longest label kept on a value. */
  maxLabelLength: 120,
} as const;

/* ------------------------------------------------------------------ *
 * SQL helpers.
 * ------------------------------------------------------------------ */

/** Statements an importer may run: an allowlist, never a denylist. */
const ALLOWED_LEADING_KEYWORDS = ["select", "with"] as const;

/** Strip comments so the guard sees the real first token. */
function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .trim();
}

/**
 * Why this SQL may not run unattended, or null when it may.
 *
 * Two checks: one statement only (a trailing `;` is fine, anything after it is
 * not), and it must begin with `SELECT` or `WITH`. Engines that can enforce a
 * read-only session do so as well; this is the floor for all of them.
 */
export function businessMetricSqlProblem(sql: string): string | null {
  if (sql.length > BUSINESS_METRIC_SOURCE_LIMITS.maxSqlLength) {
    return `The query is longer than ${BUSINESS_METRIC_SOURCE_LIMITS.maxSqlLength} characters.`;
  }
  const normalized = stripSqlComments(sql);
  if (!normalized) return "The query is empty.";
  const withoutTrailing = normalized.replace(/;\s*$/, "");
  const withoutStrings = withoutTrailing
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''")
    .replace(/"(?:[^"\\]|\\.|"")*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
  if (withoutStrings.includes(";")) {
    return "An importer runs one statement. Remove the extra statements.";
  }
  const firstWord = withoutTrailing.split(/[\s(]+/)[0]?.toLowerCase() ?? "";
  if (!(ALLOWED_LEADING_KEYWORDS as readonly string[]).includes(firstWord)) {
    return "An importer may only run SELECT or WITH statements: it runs unattended, on a schedule, with the account's credentials.";
  }
  return null;
}

/** Throws when {@link businessMetricSqlProblem} rejects `sql`. */
export function assertBusinessMetricSql(sql: string): void {
  const problem = businessMetricSqlProblem(sql);
  if (problem) throw new Error(problem);
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** True for a `YYYY-MM-DD` string that is a real calendar date. */
export function isBusinessMetricDay(day: string): boolean {
  if (!ISO_DAY.test(day)) return false;
  const parsed = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
}

/** True when `tz` is an IANA zone this runtime knows. */
export function isValidTimezone(tz: string): boolean {
  if (!/^[A-Za-z0-9_+\-/]{1,64}$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The day after `day`, YYYY-MM-DD. */
export function nextBusinessMetricDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Substitute the range placeholders a SQL importer may use:
 *
 * - `{{from}}`: first day, inclusive, as a quoted `'YYYY-MM-DD'` literal.
 * - `{{to}}`: last day, inclusive.
 * - `{{to_exclusive}}`: the day after `to`, for `ts < {{to_exclusive}}`.
 * - `{{timezone}}`: the importer's IANA timezone, quoted.
 *
 * Every substituted value is validated first (real calendar days, a known
 * timezone), so the literal can never carry anything but those characters.
 */
export function bindBusinessMetricSqlRange(
  sql: string,
  range: Pick<BusinessMetricSourceRange, "from" | "to" | "timezone">,
): string {
  if (!isBusinessMetricDay(range.from) || !isBusinessMetricDay(range.to)) {
    throw new Error("The import window must be two YYYY-MM-DD days.");
  }
  if (!isValidTimezone(range.timezone)) {
    throw new Error(`Unknown timezone "${range.timezone}".`);
  }
  const values: Record<string, string> = {
    from: range.from,
    to: range.to,
    to_exclusive: nextBusinessMetricDay(range.to),
    timezone: range.timezone,
  };
  return sql.replace(/\{\{\s*(from|to_exclusive|to|timezone)\s*\}\}/g, (_m, name: string) => {
    return `'${values[name]}'`;
  });
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Coerce whatever a driver returned for a date column into YYYY-MM-DD, or null. */
export function coerceBusinessMetricDay(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return null;
    // Drivers hand a DATE back as local midnight (node-postgres, mysql2);
    // anything else is a timestamp and its UTC calendar day is the honest read.
    const localMidnight = raw.getHours() === 0 && raw.getMinutes() === 0 && raw.getSeconds() === 0;
    return localMidnight
      ? `${raw.getFullYear()}-${pad2(raw.getMonth() + 1)}-${pad2(raw.getDate())}`
      : raw.toISOString().slice(0, 10);
  }
  if (typeof raw === "object" && raw !== null && "value" in raw) {
    return coerceBusinessMetricDay((raw as { value: unknown }).value);
  }
  const text = String(raw).trim();
  const day = text.slice(0, 10);
  return isBusinessMetricDay(day) ? day : null;
}

/** Coerce a driver's numeric (number, numeric string, bigint) into a finite number, or null. */
export function coerceBusinessMetricNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "bigint") return Number(raw);
  if (typeof raw === "object" && raw !== null && "value" in raw) {
    return coerceBusinessMetricNumber((raw as { value: unknown }).value);
  }
  const parsed = Number(String(raw).trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Turn SQL result rows into points.
 *
 * The contract a SQL importer's query satisfies: a `day` (or `date`) column,
 * a `value` column, and optionally a `label` column; matched
 * case-insensitively. A row whose day or value cannot be read fails the whole
 * run with the row number, rather than being skipped: a skipped row is a
 * missing day nobody is told about.
 */
export function rowsToBusinessMetricPoints(
  rows: Record<string, unknown>[],
  maxRows: number = BUSINESS_METRIC_SOURCE_LIMITS.maxRows,
): BusinessMetricSourcePoint[] {
  if (rows.length > maxRows) {
    throw new Error(
      `The query returned more than ${maxRows} rows. Group by day in the query so it returns one row per day (and label).`,
    );
  }
  if (rows.length === 0) return [];
  const columns = Object.keys(rows[0]!);
  const find = (...names: string[]) => columns.find((c) => names.includes(c.toLowerCase()));
  const dayCol = find("day", "date");
  const valueCol = find("value");
  const labelCol = find("label");
  if (!dayCol || !valueCol) {
    throw new Error(
      `The query must return a "day" column and a "value" column (got: ${columns.join(", ") || "none"}).`,
    );
  }
  return rows.map((row, index) => {
    const date = coerceBusinessMetricDay(row[dayCol]);
    if (!date) {
      throw new Error(`Row ${index + 1}: "${dayCol}" is not a date (${String(row[dayCol])}).`);
    }
    const value = coerceBusinessMetricNumber(row[valueCol]);
    if (value === null) {
      throw new Error(
        `Row ${index + 1}: "${valueCol}" is not a number (${String(row[valueCol])}).`,
      );
    }
    const rawLabel = labelCol ? row[labelCol] : null;
    const label =
      rawLabel === null || rawLabel === undefined
        ? ""
        : String(rawLabel).slice(0, BUSINESS_METRIC_SOURCE_LIMITS.maxLabelLength);
    return label ? { date, value, label } : { date, value };
  });
}

/* ------------------------------------------------------------------ *
 * Timezone helpers for metric sources that return timestamps.
 * ------------------------------------------------------------------ */

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

/** The calendar day an instant falls on in `timezone`, YYYY-MM-DD. */
export function localDayOf(epochMs: number, timezone: string): string {
  let fmt = dayFormatters.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dayFormatters.set(timezone, fmt);
  }
  return fmt.format(new Date(epochMs));
}

/** Offset of `timezone` from UTC at `epochMs`, in milliseconds (east positive). */
function zoneOffsetMs(epochMs: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(epochMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/** The UTC instant local midnight of `day` falls on in `timezone`. */
export function zonedDayStartMs(day: string, timezone: string): number {
  const naive = Date.parse(`${day}T00:00:00Z`);
  // Two passes settle the offset across a DST change at midnight.
  let guess = naive - zoneOffsetMs(naive, timezone);
  guess = naive - zoneOffsetMs(guess, timezone);
  return guess;
}

/**
 * Race `work` against the range's timeout and abort signal. The source should
 * also pass `range.signal` to its own requests; this is the backstop that
 * guarantees the host gets an answer in time.
 */
export async function withBusinessMetricTimeout<T>(
  work: Promise<T>,
  range: Pick<BusinessMetricSourceRange, "timeoutMs" | "signal">,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(`The source did not answer within ${Math.round(range.timeoutMs / 1000)}s.`),
        ),
      range.timeoutMs,
    );
  });
  const aborted = new Promise<never>((_, reject) => {
    range.signal?.addEventListener("abort", () => reject(new Error("The run was cancelled.")), {
      once: true,
    });
  });
  try {
    return await Promise.race([work, timeout, aborted]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
