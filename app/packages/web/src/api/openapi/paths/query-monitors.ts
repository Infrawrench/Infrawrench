import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const QueryMonitorMode = z.enum(["scalar", "rowCount"]).openapi({
  description:
    "How the result is reduced to one number. `scalar` reads the first column of the first row; " +
    "`rowCount` counts the rows, which is what lets `SELECT … WHERE broken` be a monitor.",
});

const QueryMonitorOperator = z.enum(["gt", "gte", "lt", "lte", "eq", "neq"]);

const QueryMonitorState = z.enum(["ok", "breaching", "unknown"]).openapi({
  description:
    "`unknown` is a first-class state, not an absence: a monitor whose query failed has not told " +
    "you the data is fine, and rendering that as `ok` is how a broken monitor becomes " +
    "indistinguishable from a healthy one.",
});

export function registerQueryMonitorPaths(ctx: BuildContext) {
  const { registry } = ctx;

  const QueryMonitor = strict({
    id: Uuid,
    name: z.string(),
    description: z.string().nullable(),
    accountId: Uuid,
    accountName: z.string().nullable(),
    resourceId: z.string().nullable(),
    resourceTypeId: z.string().nullable(),
    resourceName: z.string().nullable(),
    sql: z.string(),
    mode: QueryMonitorMode,
    operator: QueryMonitorOperator,
    threshold: z.number(),
    intervalMinutes: z.number().int(),
    consecutiveBreaches: z
      .number()
      .int()
      .describe(
        "Consecutive breaching runs before the alert fires. A query against a live table is a " +
          "sample: a count that dips while a batch job is mid-write is not an incident, and a " +
          "monitor that pages on it gets muted within a week.",
      ),
    enabled: z.boolean(),
    state: QueryMonitorState,
    lastValue: z.number().nullable(),
    lastRunAt: IsoDateTime.nullable(),
    lastError: z
      .string()
      .nullable()
      .describe(
        "Why the last run said nothing. Kept apart from the state because 'the monitor is broken' " +
          "and 'the data is bad' need different people.",
      ),
    breachStreak: z.number().int(),
    lastAlertedAt: IsoDateTime.nullable(),
    createdByUserId: Uuid.nullable(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  }).openapi("QueryMonitor");

  const QueryMonitorList = strict({ monitors: z.array(QueryMonitor) }).openapi("QueryMonitorList");

  const QueryMonitorCreate = strict({
    name: z.string().min(1).max(120),
    description: z.string().max(1000).nullable().optional(),
    accountId: Uuid,
    resourceId: z.string().nullable().optional(),
    resourceTypeId: z.string().nullable().optional(),
    sql: z.string().min(1).max(8000),
    mode: QueryMonitorMode,
    operator: QueryMonitorOperator,
    threshold: z.number(),
    intervalMinutes: z.number().int().min(5).max(10080),
    consecutiveBreaches: z.number().int().min(1).max(10).optional(),
    enabled: z.boolean().optional(),
  }).openapi("QueryMonitorCreate");

  const QueryMonitorUpdate = QueryMonitorCreate.partial().openapi("QueryMonitorUpdate");

  const QueryMonitorTargetResource = strict({
    id: z.string(),
    name: z.string(),
    resourceTypeId: z.string(),
    typeName: z.string().describe("The resource type's display name, e.g. 'D1 Database'."),
  }).openapi("QueryMonitorTargetResource");

  const QueryMonitorTargetAccount = strict({
    id: Uuid,
    name: z.string(),
    accountSql: z
      .boolean()
      .describe("The account itself has a SQL driver, so it is a valid target on its own."),
    resources: z.array(QueryMonitorTargetResource),
  }).openapi("QueryMonitorTargetAccount");

  const QueryMonitorTargets = strict({
    accounts: z.array(QueryMonitorTargetAccount),
  }).openapi("QueryMonitorTargets");

  const QueryMonitorTestResult = strict({
    value: z.number().nullable(),
    state: QueryMonitorState,
    error: z.string().nullable(),
    durationMs: z.number().int(),
    rows: z.array(z.record(z.string(), z.unknown())).describe("Up to 20 rows, for the preview."),
  }).openapi("QueryMonitorTestResult");

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/query-monitors",
    tags: ["Query monitors"],
    summary: "List query monitors",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Monitors, by name",
        content: { "application/json": { schema: QueryMonitorList } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/query-monitors",
    tags: ["Query monitors"],
    summary: "Create a query monitor",
    description:
      "A monitor may only run `select`, `with`, `show` or `explain`, and only a **single** " +
      "statement. That is a deliberate allowlist of leading keywords rather than a denylist of " +
      "dangerous ones: a denylist has to be right about every dialect's spelling of every " +
      "destructive verb, forever, and only has to be wrong once. Comments are stripped before " +
      "the check, so `-- harmless\\nDROP TABLE x` is rejected, and `SELECT 1; DROP TABLE x` is " +
      "rejected by the single-statement rule.\n\n" +
      "Takes `resources:execute`, like the SQL editor: saving a monitor arranges for a query to " +
      "run against a customer database on a schedule, forever, which is a strictly larger act " +
      "than running one while watching it.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: QueryMonitorCreate } } },
    },
    responses: {
      200: {
        description: "The created monitor",
        content: { "application/json": { schema: QueryMonitor } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
      409: ErrorResponses[409],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/query-monitors/targets",
    tags: ["Query monitors"],
    summary: "List what a monitor can run against",
    description:
      "The editor's target picker: each account with a SQL driver of its own, plus the " +
      "SQL-capable resources inside it — a database that is a *resource* (a ClickHouse service, " +
      "a D1 or Turso database, a Databricks SQL warehouse, a BigQuery dataset) rather than the " +
      "account's own connection. Accounts with neither are omitted; a monitor pointed at one " +
      "could only ever fail. Pass a resource's `id` (and optionally its `resourceTypeId` — the " +
      "server fills it from the synced resource either way) when creating a monitor to scope " +
      "the query to that resource.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Targets, grouped by account",
        content: { "application/json": { schema: QueryMonitorTargets } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/query-monitors/test",
    tags: ["Query monitors"],
    summary: "Run a query once without saving it",
    description:
      "The editor's 'try it' button. Goes through the same read-only guard as a scheduled run — " +
      "a query that could not be saved as a monitor must not be runnable through the monitor's " +
      "own preview — and applies the threshold, so the answer says whether it *would* be " +
      "breaching rather than leaving the reader to compare two numbers.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: QueryMonitorCreate.partial() } } },
    },
    responses: {
      200: {
        description: "What the query returned",
        content: { "application/json": { schema: QueryMonitorTestResult } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/query-monitors/{monitorId}",
    tags: ["Query monitors"],
    summary: "Get one query monitor",
    request: { params: OrgIdParam.extend({ monitorId: Uuid }) },
    responses: {
      200: {
        description: "The monitor",
        content: { "application/json": { schema: QueryMonitor } },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/org/{orgId}/query-monitors/{monitorId}",
    tags: ["Query monitors"],
    summary: "Edit a query monitor",
    description:
      "Omitted fields are left alone and the result is validated after merging. Changing the " +
      "query, the mode, the operator or the threshold **re-arms** the monitor: the stored breach " +
      "streak was accumulated against a different question, and carrying it forward would fire " +
      "an alert on the first run of a rule nobody has tested.",
    request: {
      params: OrgIdParam.extend({ monitorId: Uuid }),
      body: { content: { "application/json": { schema: QueryMonitorUpdate } } },
    },
    responses: {
      200: {
        description: "The updated monitor",
        content: { "application/json": { schema: QueryMonitor } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
      409: ErrorResponses[409],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/query-monitors/{monitorId}",
    tags: ["Query monitors"],
    summary: "Delete a query monitor",
    request: { params: OrgIdParam.extend({ monitorId: Uuid }) },
    responses: { 204: { description: "The monitor was deleted" }, 404: ErrorResponses[404] },
  });
}
