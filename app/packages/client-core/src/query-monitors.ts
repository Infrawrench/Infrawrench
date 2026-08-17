/**
 * Query monitors — a SQL query on a schedule, with a threshold and an alert.
 *
 * Metric alerts watch what the *provider* reports: CPU, connections, queue
 * depth. Nothing watched what the data itself says, which is where a whole
 * class of incidents lives — the orders table stopped growing, the dead-letter
 * queue has 4,000 rows in it, yesterday's ETL wrote nought. Those are visible in
 * one query and in no metric.
 *
 * This module is the pure half: the shapes, the validation both the editor and
 * the API enforce, the read-only guard that decides whether a query may be
 * scheduled at all, and the comparison that turns a result into a state.
 */

/** How a result is reduced to one number. */
export type QueryMonitorMode =
  /** The first column of the first row, which must be numeric. */
  | "scalar"
  /** How many rows came back. Lets `SELECT … WHERE broken` be a monitor. */
  | "rowCount";

export type QueryMonitorOperator = "gt" | "gte" | "lt" | "lte" | "eq" | "neq";

/**
 * What the last run concluded.
 *
 * `unknown` is a first-class state, not an absence. A monitor whose query
 * failed has *not* told you the data is fine, and rendering that as `ok` is how
 * a broken monitor becomes indistinguishable from a healthy one — the failure
 * mode this whole feature exists to prevent.
 */
export type QueryMonitorState = "ok" | "breaching" | "unknown";

export interface QueryMonitor {
  id: string;
  name: string;
  description: string | null;
  accountId: string;
  accountName: string | null;
  /** Set when the query runs against one resource rather than the account. */
  resourceId: string | null;
  resourceTypeId: string | null;
  resourceName: string | null;
  sql: string;
  mode: QueryMonitorMode;
  operator: QueryMonitorOperator;
  threshold: number;
  /** Minutes between runs. */
  intervalMinutes: number;
  /**
   * Consecutive breaching runs before the alert fires.
   *
   * Defaults to 1, but exists because a query against a live table is a
   * *sample*: a count that dips for one run while a batch job is mid-write is
   * not an incident, and a monitor that pages on it gets muted within a week.
   */
  consecutiveBreaches: number;
  enabled: boolean;
  /** Last run's outcome. */
  state: QueryMonitorState;
  lastValue: number | null;
  lastRunAt: string | null;
  lastError: string | null;
  /** How many consecutive breaching runs have been seen. */
  breachStreak: number;
  /** When the alert last fired, so the UI can say "already paged". */
  lastAlertedAt: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QueryMonitorInput {
  name: string;
  description?: string | null;
  accountId: string;
  resourceId?: string | null;
  resourceTypeId?: string | null;
  sql: string;
  mode: QueryMonitorMode;
  operator: QueryMonitorOperator;
  threshold: number;
  intervalMinutes: number;
  consecutiveBreaches?: number;
  enabled?: boolean;
}

export const QUERY_MONITOR_LIMITS = {
  maxPerOrg: 100,
  maxNameLength: 120,
  maxDescriptionLength: 1000,
  maxSqlLength: 8000,
  minIntervalMinutes: 5,
  /** A week. Past that it is a report, not a monitor. */
  maxIntervalMinutes: 10_080,
  minConsecutiveBreaches: 1,
  maxConsecutiveBreaches: 10,
  /** Seconds a monitor's query may run before it is abandoned. */
  timeoutSeconds: 30,
} as const;

export const QUERY_MONITOR_OPERATOR_LABELS: Record<QueryMonitorOperator, string> = {
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  eq: "=",
  neq: "≠",
};

/**
 * Statements a monitor is allowed to run.
 *
 * A monitor executes **unattended, on a schedule, with the account's
 * credentials, forever**. That is a categorically different risk from the SQL
 * editor, where a person types a statement and watches it run — so the editor's
 * permission model is not enough here, and the guard is a property of the
 * *stored* query rather than of the person who saved it.
 *
 * The rule is a deliberate allowlist of leading keywords, not a denylist of
 * dangerous ones: a denylist has to be right about every dialect's spelling of
 * every destructive verb, forever, and it only has to be wrong once.
 */
const ALLOWED_LEADING_KEYWORDS = ["select", "with", "show", "explain"] as const;

/**
 * Strip comments and leading whitespace so the guard sees the real first token.
 *
 * `-- harmless\nDROP TABLE x` starts with a comment; a check that only looked
 * at `trimStart()` would read the comment as the statement and let it through.
 */
export function normalizeMonitorSql(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .trim();
}

/**
 * Is this query safe to run unattended?
 *
 * Returns the reason it is not, or null. Two checks: the statement must begin
 * with a read-only keyword, and it must be a **single** statement — because
 * `SELECT 1; DROP TABLE users` begins with `select` and the leading-keyword
 * check alone would wave it through.
 *
 * A trailing semicolon is allowed; anything after one is not.
 */
export function monitorSqlProblem(sql: string): string | null {
  const normalized = normalizeMonitorSql(sql);
  if (!normalized) return "The query is empty.";

  const withoutTrailing = normalized.replace(/;\s*$/, "");
  // Semicolons inside string literals are legitimate. Strip quoted spans before
  // looking for a statement separator, so `SELECT 'a;b'` is not rejected.
  const withoutStrings = withoutTrailing
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''")
    .replace(/"(?:[^"\\]|\\.|"")*"/g, '""');
  if (withoutStrings.includes(";")) {
    return "A monitor runs one statement. Remove the extra statements.";
  }

  const firstWord = withoutTrailing.split(/[\s(]+/)[0]?.toLowerCase() ?? "";
  if (!(ALLOWED_LEADING_KEYWORDS as readonly string[]).includes(firstWord)) {
    return `A monitor may only run ${ALLOWED_LEADING_KEYWORDS.join(", ")} statements — it runs unattended, on a schedule, with your account's credentials.`;
  }
  return null;
}

/** Validate a monitor as the editor and the API both see it. */
export function validateQueryMonitor(input: QueryMonitorInput): string | null {
  const name = input.name?.trim() ?? "";
  if (!name) return "A name is required.";
  if (name.length > QUERY_MONITOR_LIMITS.maxNameLength) {
    return `Name must be ${QUERY_MONITOR_LIMITS.maxNameLength} characters or fewer.`;
  }
  if ((input.description?.length ?? 0) > QUERY_MONITOR_LIMITS.maxDescriptionLength) {
    return `Description must be ${QUERY_MONITOR_LIMITS.maxDescriptionLength} characters or fewer.`;
  }
  if (!input.accountId) return "Choose an account to run the query against.";
  if (!input.sql?.trim()) return "The query is empty.";
  if (input.sql.length > QUERY_MONITOR_LIMITS.maxSqlLength) {
    return `The query must be ${QUERY_MONITOR_LIMITS.maxSqlLength} characters or fewer.`;
  }
  const sqlProblem = monitorSqlProblem(input.sql);
  if (sqlProblem) return sqlProblem;

  if (!Number.isFinite(input.threshold)) return "The threshold must be a number.";
  if (
    !Number.isInteger(input.intervalMinutes) ||
    input.intervalMinutes < QUERY_MONITOR_LIMITS.minIntervalMinutes ||
    input.intervalMinutes > QUERY_MONITOR_LIMITS.maxIntervalMinutes
  ) {
    return `The interval must be between ${QUERY_MONITOR_LIMITS.minIntervalMinutes} minutes and a week.`;
  }
  const streak = input.consecutiveBreaches ?? 1;
  if (
    !Number.isInteger(streak) ||
    streak < QUERY_MONITOR_LIMITS.minConsecutiveBreaches ||
    streak > QUERY_MONITOR_LIMITS.maxConsecutiveBreaches
  ) {
    return `Consecutive breaches must be between ${QUERY_MONITOR_LIMITS.minConsecutiveBreaches} and ${QUERY_MONITOR_LIMITS.maxConsecutiveBreaches}.`;
  }
  // A resource type without a resource (or the reverse) cannot be resolved to a
  // connection; rejecting it here beats a runtime "no SQL driver available".
  if (Boolean(input.resourceId) !== Boolean(input.resourceTypeId)) {
    return "A monitor scoped to a resource needs both the resource and its type.";
  }
  return null;
}

/** Does the observed value breach the threshold? Pure; total over the operators. */
export function breaches(
  value: number,
  operator: QueryMonitorOperator,
  threshold: number,
): boolean {
  switch (operator) {
    case "gt":
      return value > threshold;
    case "gte":
      return value >= threshold;
    case "lt":
      return value < threshold;
    case "lte":
      return value <= threshold;
    case "eq":
      return value === threshold;
    case "neq":
      return value !== threshold;
  }
}

export interface MonitorRunOutcome {
  state: QueryMonitorState;
  value: number | null;
  error: string | null;
  /** The streak after this run. */
  breachStreak: number;
  /** Whether this run is the one that should raise an alert. */
  shouldAlert: boolean;
}

/**
 * Fold one run's result into the monitor's new state.
 *
 * Three rules, each of them a decision:
 *
 * - **A failed query is `unknown`, never `ok` and never `breaching`.** It has
 *   told you nothing about the data. Rendering it as healthy hides a broken
 *   monitor; rendering it as breaching pages somebody about a connection
 *   problem using the wording of a data problem.
 * - **A failure does not reset the streak.** A monitor that breaches, errors,
 *   then breaches again has breached twice, and treating the error as a
 *   recovery would let an intermittently failing query hold off an alert
 *   forever.
 * - **The alert fires on the run that *reaches* the streak, not on every run
 *   past it.** `shouldAlert` is true exactly once per breach episode; the
 *   caller re-arms it by seeing an `ok` run.
 */
export function foldMonitorRun(options: {
  previousStreak: number;
  operator: QueryMonitorOperator;
  threshold: number;
  consecutiveBreaches: number;
  value?: number | null | undefined;
  error?: string | null | undefined;
}): MonitorRunOutcome {
  if (options.error) {
    return {
      state: "unknown",
      value: null,
      error: options.error,
      breachStreak: options.previousStreak,
      shouldAlert: false,
    };
  }
  const value = options.value;
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return {
      state: "unknown",
      value: null,
      error: "The query returned no comparable number.",
      breachStreak: options.previousStreak,
      shouldAlert: false,
    };
  }

  if (!breaches(value, options.operator, options.threshold)) {
    return { state: "ok", value, error: null, breachStreak: 0, shouldAlert: false };
  }

  const streak = options.previousStreak + 1;
  return {
    state: "breaching",
    value,
    error: null,
    breachStreak: streak,
    // Exactly on the run that reaches the threshold: `>` rather than `>=`
    // would never fire, `>=` on every subsequent run would page hourly.
    shouldAlert: streak === options.consecutiveBreaches,
  };
}

/**
 * Reduce a query result to the number the threshold is compared against.
 *
 * Returns null rather than throwing when there is nothing comparable — the
 * caller turns that into `unknown`, which is the honest state for "the query
 * ran but said nothing I can measure".
 */
export function readMonitorValue(
  rows: ReadonlyArray<Record<string, unknown>>,
  mode: QueryMonitorMode,
): number | null {
  if (mode === "rowCount") return rows.length;
  const first = rows[0];
  if (!first) return null;
  const firstValue = Object.values(first)[0];
  if (typeof firstValue === "number") return Number.isFinite(firstValue) ? firstValue : null;
  // Drivers return counts as strings often enough (bigint columns, in
  // particular) that refusing them would make `SELECT count(*)` — the most
  // obvious monitor anybody writes — not work.
  if (typeof firstValue === "string" && firstValue.trim() !== "") {
    const parsed = Number(firstValue);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** One sentence describing what the monitor watches, for an alert body. */
export function describeQueryMonitor(monitor: {
  mode: QueryMonitorMode;
  operator: QueryMonitorOperator;
  threshold: number;
}): string {
  const subject = monitor.mode === "rowCount" ? "row count" : "value";
  return `${subject} ${QUERY_MONITOR_OPERATOR_LABELS[monitor.operator]} ${monitor.threshold}`;
}
