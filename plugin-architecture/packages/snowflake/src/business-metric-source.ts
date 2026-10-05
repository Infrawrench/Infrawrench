/**
 * Snowflake as a business-metric source: a scheduled SQL query, sent through
 * the SQL API like every other statement this plugin runs, whose rows (`day`,
 * `value`, optional `label`) become a unit-cost denominator.
 *
 * Read-only is `validated`, not `enforced`: Snowflake has no session setting
 * that refuses writes, so the guarantee is the shared statement check (one
 * SELECT/WITH statement, run on every execution) plus
 * `MULTI_STATEMENT_COUNT = 1`, which makes the SQL API itself reject a request
 * carrying more than one statement. The role the query runs as is the other
 * line of defence, which is why the form offers a role picker.
 *
 * SQL API reference (docs.snowflake.com/en/developer-guide/sql-api/reference,
 * 2026-10): `timeout` is seconds; `parameters` accepts `multi_statement_count`
 * (default 1), `rows_per_resultset`, `timezone` and `query_tag` among a short
 * allowlist; larger results are split into partitions read with
 * `GET /api/v2/statements/{handle}?partition=N` (handled by `runSql`).
 */
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
import type { SnowflakeContext, StatementOptions } from "./api.js";
import { ident, runSql, str } from "./api.js";

export const BUSINESS_METRIC_QUERY_TAG = "infrawrench-business-metric";

export const snowflakeBusinessMetricSource: BusinessMetricSourceDeclaration = {
  label: "Snowflake SQL",
  description:
    "Run a Snowflake SQL query on a schedule. It must return one row per day with a `day` and a `value` column, plus an optional `label` column for a breakdown.",
  kind: "sql",
  sqlDialect: "Snowflake SQL",
  readOnly: "validated",
  fields: [
    {
      key: "warehouse",
      label: "Warehouse",
      type: "select",
      description:
        "The warehouse the query runs on, and which is billed for it. Leave empty to use the account's warehouse.",
    },
    {
      key: "role",
      label: "Role",
      type: "select",
      allowCustom: true,
      description:
        "Optional. The role the query runs as. Snowflake cannot make a session read-only, so pick a role that can only read the data the query needs. Leave empty to use the account's role.",
    },
    {
      key: "database",
      label: "Database",
      type: "select",
      required: true,
      description: "Default database: unqualified table names resolve here.",
    },
    {
      key: "schema",
      label: "Schema",
      type: "select",
      dependsOn: ["database"],
      description: "Optional default schema within the database.",
    },
    {
      key: "sql",
      label: "Query",
      type: "sql",
      required: true,
      description:
        "A single SELECT returning `day`, `value` and optionally `label`. {{from}}, {{to}}, {{to_exclusive}} and {{timezone}} are replaced with quoted values for the import window. The session timezone is the importer's timezone, so casting a TIMESTAMP_LTZ to DATE gives local days.",
      placeholder:
        "SELECT created_at::date AS day, COUNT(DISTINCT customer_id) AS value\nFROM orders\nWHERE created_at::date BETWEEN {{from}} AND {{to}}\nGROUP BY day",
    },
  ],
};

function param(params: Record<string, string>, key: string): string {
  return params[key]?.trim() ?? "";
}

/** Context overrides from the form: an empty picker keeps the account's default. */
function contextOf(params: Record<string, string>): Pick<StatementOptions, "warehouse" | "role"> {
  const warehouse = param(params, "warehouse");
  const role = param(params, "role");
  return { ...(warehouse ? { warehouse } : {}), ...(role ? { role } : {}) };
}

async function show(
  ctx: SnowflakeContext,
  statement: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>[]> {
  return (await runSql(ctx, statement, { ...contextOf(params), maxRows: 5000 })).rows;
}

function byLabel(a: BusinessMetricSourceOption, b: BusinessMetricSourceOption): number {
  return a.label.localeCompare(b.label);
}

export async function listSnowflakeBusinessMetricOptions(
  ctx: SnowflakeContext,
  fieldKey: string,
  params: Record<string, string>,
): Promise<BusinessMetricSourceOption[]> {
  switch (fieldKey) {
    case "warehouse": {
      const rows = await show(ctx, "SHOW WAREHOUSES", params);
      return rows
        .map((r) => {
          const name = str(r["name"]);
          const detail = [str(r["size"]), str(r["state"]).toLowerCase()].filter(Boolean).join(", ");
          return { id: name, label: name, ...(detail ? { description: detail } : {}) };
        })
        .filter((o) => o.id)
        .sort(byLabel);
    }
    case "database": {
      const rows = await show(ctx, "SHOW DATABASES", params);
      return rows
        .map((r) => {
          const name = str(r["name"]);
          const comment = str(r["comment"]);
          return { id: name, label: name, ...(comment ? { description: comment } : {}) };
        })
        .filter((o) => o.id)
        .sort(byLabel);
    }
    case "schema": {
      const database = param(params, "database");
      if (!database) return [];
      const rows = await show(ctx, `SHOW SCHEMAS IN DATABASE ${ident(database)}`, params);
      return rows
        .map((r) => str(r["name"]))
        .filter((name) => name && name.toUpperCase() !== "INFORMATION_SCHEMA")
        .map((name) => ({ id: name, label: name }))
        .sort(byLabel);
    }
    case "role": {
      // Roles granted to the connecting user (directly or through the role
      // hierarchy), not every role in the account. Account-level roles only.
      let roles: unknown = [];
      try {
        const res = await runSql(ctx, "SELECT CURRENT_AVAILABLE_ROLES() AS roles", {
          ...(param(params, "warehouse") ? { warehouse: param(params, "warehouse") } : {}),
          maxRows: 1,
        });
        roles = JSON.parse(str(res.rows[0]?.["roles"]) || "[]");
      } catch {
        // No warehouse to run the function on: fall back to the roles the
        // account's role can see. The field accepts a typed name either way.
        roles = (await show(ctx, "SHOW ROLES", {})).map((r) => str(r["name"]));
      }
      return (Array.isArray(roles) ? roles : [])
        .map((r) => String(r))
        .filter(Boolean)
        .map((name) => ({ id: name, label: name }))
        .sort(byLabel);
    }
    default:
      return [];
  }
}

export async function runSnowflakeBusinessMetricSource(
  ctx: SnowflakeContext,
  params: Record<string, string>,
  range: BusinessMetricSourceRange,
): Promise<BusinessMetricSourceResult> {
  const raw = params["sql"] ?? "";
  // On every execution, not only when the importer was saved.
  assertBusinessMetricSql(raw);
  const database = param(params, "database");
  if (!database) throw new Error("Pick the database the query runs against.");
  const schema = param(params, "schema");
  const statement = bindBusinessMetricSqlRange(raw, range);
  const context = contextOf(params);

  const result = await withBusinessMetricTimeout(
    runSql(ctx, statement, {
      ...context,
      database,
      ...(schema ? { schema } : {}),
      timeoutSec: Math.max(1, Math.ceil(range.timeoutMs / 1000)),
      // One row past the cap so an overflow is detected rather than truncated.
      maxRows: range.maxRows + 1,
      parameters: {
        multi_statement_count: 1,
        rows_per_resultset: range.maxRows + 1,
        timezone: range.timezone,
        query_tag: BUSINESS_METRIC_QUERY_TAG,
      },
      ...(range.signal ? { signal: range.signal } : {}),
    }),
    range,
  );
  if (result.truncated || result.rows.length > range.maxRows) {
    throw new Error(
      `The query returned more than ${range.maxRows} rows. Group by day in the query so it returns one row per day (and label).`,
    );
  }
  const points = rowsToBusinessMetricPoints(result.rows, range.maxRows);
  const notes = [`${result.rows.length} row${result.rows.length === 1 ? "" : "s"}`];
  const warehouse = context.warehouse ?? ctx.warehouse;
  if (warehouse) notes.push(`Warehouse ${warehouse}`);
  if (result.statementHandle) notes.push(`Statement ${result.statementHandle}`);
  return { points, notes };
}
