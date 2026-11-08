/**
 * Query monitors: `/api/org/:orgId/query-monitors`, the endpoint definitions.
 *
 * Reading takes `resources:read`. Writing and test-running take
 * `resources:execute`, the SQL editor's permission: saving a monitor arranges
 * for a query to run against a customer database on a schedule, forever.
 *
 * The write bodies are documented here and checked by hand in the handlers,
 * whose 400s name the field at fault, so those endpoints are served raw.
 */
import { Schema, Struct } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { maxLength, minLength } from "../schemas";
import { RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, Conflict, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { IsoDateTime, OrgId, OrgParams, Uuid } from "../http/schemas/common";

export const QUERY_MONITOR_MODES = ["scalar", "rowCount"] as const;
export const QUERY_MONITOR_OPERATORS = ["gt", "gte", "lt", "lte", "eq", "neq"] as const;

export const QueryMonitorMode = Schema.Literals(QUERY_MONITOR_MODES).annotate({
  description:
    "How the result is reduced to one number. `scalar` reads the first column of the first row; " +
    "`rowCount` counts the rows, which is what lets `SELECT … WHERE broken` be a monitor.",
});

export const QueryMonitorOperator = Schema.Literals(QUERY_MONITOR_OPERATORS);

const QueryMonitorState = Schema.Literals(["ok", "breaching", "unknown"]).annotate({
  description:
    "`unknown` is a first-class state, not an absence: a monitor whose query failed has not told " +
    "you the data is fine, and rendering that as `ok` is how a broken monitor becomes " +
    "indistinguishable from a healthy one.",
});

export const QueryMonitor = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  accountId: Uuid,
  accountName: Schema.NullOr(Schema.String),
  resourceId: Schema.NullOr(Schema.String),
  resourceTypeId: Schema.NullOr(Schema.String),
  resourceName: Schema.NullOr(Schema.String),
  sql: Schema.String,
  mode: QueryMonitorMode,
  operator: QueryMonitorOperator,
  threshold: Schema.Finite,
  intervalMinutes: Schema.Int,
  consecutiveBreaches: Schema.Int.annotate({
    description:
      "Consecutive breaching runs before the alert fires. A query against a live table is a " +
      "sample: a count that dips while a batch job is mid-write is not an incident, and a " +
      "monitor that pages on it gets muted within a week.",
  }),
  enabled: Schema.Boolean,
  state: QueryMonitorState,
  lastValue: Schema.NullOr(Schema.Finite),
  lastRunAt: Schema.NullOr(IsoDateTime),
  lastError: Schema.NullOr(Schema.String).annotate({
    description:
      "Why the last run said nothing. Kept apart from the state because 'the monitor is broken' " +
      "and 'the data is bad' need different people.",
  }),
  breachStreak: Schema.Int,
  lastAlertedAt: Schema.NullOr(IsoDateTime),
  createdByUserId: Schema.NullOr(Uuid),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "QueryMonitor" });

export const QueryMonitorList = Schema.Struct({ monitors: Schema.Array(QueryMonitor) }).annotate({
  identifier: "QueryMonitorList",
});

const monitorCreateFields = {
  name: Schema.String.check(minLength(1), maxLength(120)),
  description: Schema.optionalKey(Schema.NullOr(Schema.String.check(maxLength(1000)))),
  accountId: Uuid,
  resourceId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  resourceTypeId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  sql: Schema.String.check(minLength(1), maxLength(8000)),
  mode: QueryMonitorMode,
  operator: QueryMonitorOperator,
  threshold: Schema.Finite,
  intervalMinutes: Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 10080 })),
  consecutiveBreaches: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
  ),
  enabled: Schema.optionalKey(Schema.Boolean),
};

const QueryMonitorCreate = Schema.Struct(monitorCreateFields).annotate({
  identifier: "QueryMonitorCreate",
});

const partialMonitorFields = Struct.map(monitorCreateFields, Schema.optionalKey);

const QueryMonitorUpdate = Schema.Struct(partialMonitorFields).annotate({
  identifier: "QueryMonitorUpdate",
});

const QueryMonitorTargetResource = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  resourceTypeId: Schema.String,
  typeName: Schema.String.annotate({
    description: "The resource type's display name, e.g. 'D1 Database'.",
  }),
}).annotate({ identifier: "QueryMonitorTargetResource" });

const QueryMonitorTargetAccount = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  accountSql: Schema.Boolean.annotate({
    description: "The account itself has a SQL driver, so it is a valid target on its own.",
  }),
  resources: Schema.Array(QueryMonitorTargetResource),
}).annotate({ identifier: "QueryMonitorTargetAccount" });

export const QueryMonitorTargets = Schema.Struct({
  accounts: Schema.Array(QueryMonitorTargetAccount),
}).annotate({ identifier: "QueryMonitorTargets" });

export const QueryMonitorTestResult = Schema.Struct({
  value: Schema.NullOr(Schema.Finite),
  state: QueryMonitorState,
  error: Schema.NullOr(Schema.String),
  durationMs: Schema.Int,
  rows: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)).annotate({
    description: "Up to 20 rows, for the preview.",
  }),
}).annotate({ identifier: "QueryMonitorTestResult" });

const MonitorParams = { orgId: OrgId, monitorId: Uuid } as const;

export class QueryMonitorsGroup extends HttpApiGroup.make("queryMonitors")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: QueryMonitorList,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List query monitors")
      .annotate(SuccessDescription, "Monitors, by name"),
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: QueryMonitorCreate,
      success: QueryMonitor,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "resources:execute")
      .annotate(OpenApi.Summary, "Create a query monitor")
      .annotate(
        OpenApi.Description,
        "A monitor may only run `select`, `with`, `show` or `explain`, and only a **single** " +
          "statement. That is a deliberate allowlist of leading keywords rather than a denylist of " +
          "dangerous ones: a denylist has to be right about every dialect's spelling of every " +
          "destructive verb, forever, and only has to be wrong once. Comments are stripped before " +
          "the check, so `-- harmless\\nDROP TABLE x` is rejected, and `SELECT 1; DROP TABLE x` is " +
          "rejected by the single-statement rule.\n\n" +
          "Takes `resources:execute`, like the SQL editor: saving a monitor arranges for a query to " +
          "run against a customer database on a schedule, forever, which is a strictly larger act " +
          "than running one while watching it.",
      )
      .annotate(SuccessDescription, "The created monitor"),
    // Before `/:monitorId` in intent as in the Hono router: a static segment
    // wins over the parameter, so "targets" is never read as a monitor id.
    HttpApiEndpoint.get("targets", "/targets", {
      params: OrgParams,
      success: QueryMonitorTargets,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List what a monitor can run against")
      .annotate(
        OpenApi.Description,
        "The editor's target picker: each account with a SQL driver of its own, plus the " +
          "SQL-capable resources inside it; a database that is a *resource* (a ClickHouse service, " +
          "a D1 or Turso database, a Databricks SQL warehouse, a BigQuery dataset) rather than the " +
          "account's own connection. Accounts with neither are omitted; a monitor pointed at one " +
          "could only ever fail. Pass a resource's `id` (and optionally its `resourceTypeId`: the " +
          "server fills it from the synced resource either way) when creating a monitor to scope " +
          "the query to that resource.",
      )
      .annotate(SuccessDescription, "Targets, grouped by account"),
    HttpApiEndpoint.post("test", "/test", {
      params: OrgParams,
      // Inline, as the hand-written spec had it: the update body's fields, unnamed.
      payload: Schema.Struct(partialMonitorFields),
      success: QueryMonitorTestResult,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "resources:execute")
      .annotate(OpenApi.Summary, "Run a query once without saving it")
      .annotate(
        OpenApi.Description,
        "The editor's 'try it' button. Goes through the same read-only guard as a scheduled run; " +
          "a query that could not be saved as a monitor must not be runnable through the monitor's " +
          "own preview: and applies the threshold, so the answer says whether it *would* be " +
          "breaching rather than leaving the reader to compare two numbers.",
      )
      .annotate(SuccessDescription, "What the query returned"),
    HttpApiEndpoint.get("get", "/:monitorId", {
      params: MonitorParams,
      success: QueryMonitor,
      error: NotFound,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Get one query monitor")
      .annotate(SuccessDescription, "The monitor"),
    HttpApiEndpoint.patch("update", "/:monitorId", {
      params: MonitorParams,
      payload: QueryMonitorUpdate,
      success: QueryMonitor,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "resources:execute")
      .annotate(OpenApi.Summary, "Edit a query monitor")
      .annotate(
        OpenApi.Description,
        "Omitted fields are left alone and the result is validated after merging. Changing the " +
          "query, the mode, the operator or the threshold **re-arms** the monitor: the stored breach " +
          "streak was accumulated against a different question, and carrying it forward would fire " +
          "an alert on the first run of a rule nobody has tested.",
      )
      .annotate(SuccessDescription, "The updated monitor"),
    HttpApiEndpoint.delete("delete", "/:monitorId", {
      params: MonitorParams,
      success: HttpApiSchema.NoContent,
      error: NotFound,
    })
      .annotate(RequiredPermission, "resources:execute")
      .annotate(OpenApi.Summary, "Delete a query monitor")
      .annotate(SuccessDescription, "The monitor was deleted"),
  )
  .prefix("/api/org/:orgId/query-monitors")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Query monitors") {}

export class QueryMonitorsApi extends withApiDefaults(
  HttpApi.make("query-monitors").add(QueryMonitorsGroup),
) {}
