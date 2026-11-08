/**
 * Log workspace saved queries: `/api/org/:orgId/log-workspaces`, the endpoint
 * definitions.
 *
 * A saved query is a named set of log-capable resources plus a search
 * expression, so a multi-resource tail can be reopened and, optionally,
 * alert-evaluated by the poller. Reads are `resources:read` (a saved query
 * is a view over the org's resource logs); mutations are `resources:write`.
 *
 * The bodies are documented here and read raw by the handlers, which name
 * the field at fault in each 400, as they always have.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { maxLength, minLength } from "@infrawrench/ui/schemas";
import { RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, NotFound } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, OrgId, OrgParams, Uuid } from "../../schemas/common";
import { PluginId } from "../../schemas/plugin-registry";

const conflictAnnotations = (identifier: string) =>
  ({
    httpApiStatus: 409,
    identifier,
    description: "A saved query with this name already exists",
  }) as const;

/** The 409 creating a saved query under a name already taken answers. */
export class LogWorkspaceQueryConflict extends Schema.Error<LogWorkspaceQueryConflict>(
  "infrawrench/http/LogWorkspaceQueryConflict",
)({ error: Schema.String }, conflictAnnotations("LogWorkspaceQueryConflict")) {}

/** The same 409, for a rename; documented under its own name, as it always was. */
export class LogWorkspaceQueryUpdateConflict extends Schema.Error<LogWorkspaceQueryUpdateConflict>(
  "infrawrench/http/LogWorkspaceQueryUpdateConflict",
)({ error: Schema.String }, conflictAnnotations("LogWorkspaceQueryUpdateConflict")) {}

const SearchExpression = Schema.String.check(maxLength(500)).annotate({
  description:
    "The search expression. Empty matches every line; `/pattern/` (optionally `/pattern/i`) " +
    "is a regular expression; otherwise whitespace-separated terms that must ALL appear in a " +
    'line (case-insensitive), with `"quoted phrases"` and `-term` negation.',
  examples: ['error -healthcheck "connection reset"'],
});

const LogStreamSelector = Schema.Struct({
  resourceId: Schema.String.annotate({
    description:
      "Infrawrench resource id of the stream to tail; or, for a sidecar stream, the peer " +
      "plugin's own resource id (not a stored row).",
  }),
  accountId: Uuid,
  pluginId: PluginId,
  resourceTypeId: Schema.String,
  parentResourceId: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Set for sidecar streams (e.g. a pod inside a managed cluster): the stored parent " +
        "resource whose outputs mint the peer plugin's credentials. The logs endpoint routes " +
        "through the peer client when present.",
    }),
  ),
  container: Schema.optionalKey(
    Schema.String.annotate({
      description: "Container to fetch when the resource has more than one; omit for the default.",
    }),
  ),
}).annotate({ identifier: "LogStreamSelector" });

export const LogWorkspaceQuery = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  resources: Schema.Array(LogStreamSelector),
  search: SearchExpression,
  alertEnabled: Schema.Boolean.annotate({
    description: "When true the poller periodically evaluates the query and alerts on match.",
  }),
  lastEvalAt: Schema.NullOr(IsoDateTime).annotate({
    description: "Last time the alert pass evaluated this query; null until it has run.",
  }),
  lastMatchAt: Schema.NullOr(IsoDateTime).annotate({
    description: "Last evaluation that found at least one matching line.",
  }),
  lastAlertedAt: Schema.NullOr(IsoDateTime).annotate({
    description: "Last dispatched notification; the cooldown anchor.",
  }),
  lastEvalError: Schema.NullOr(Schema.String).annotate({
    description: "Failure detail from the last evaluation.",
  }),
  lastMatchSample: Schema.NullOr(Schema.String).annotate({
    description: "Truncated sample of the most recent matching line.",
  }),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "LogWorkspaceQuery" });

export const LogWorkspaceQueryList = Schema.Struct({
  queries: Schema.Array(LogWorkspaceQuery),
}).annotate({ identifier: "LogWorkspaceQueryList" });

const Selectors = Schema.Array(LogStreamSelector).check(minLength(1), maxLength(8));
const QueryName = Schema.String.check(minLength(1), maxLength(120));

const LogWorkspaceQueryCreate = Schema.Struct({
  name: QueryName,
  resources: Selectors,
  search: SearchExpression,
  alertEnabled: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "LogWorkspaceQueryCreate" });

const LogWorkspaceQueryUpdate = Schema.Struct({
  name: Schema.optionalKey(QueryName),
  resources: Schema.optionalKey(Selectors),
  search: Schema.optionalKey(SearchExpression),
  alertEnabled: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "LogWorkspaceQueryUpdate" });

const LogCapableResource = Schema.Struct({
  resourceId: Schema.String,
  accountId: Uuid,
  accountName: Schema.String,
  pluginId: PluginId,
  resourceTypeId: Schema.String,
  displayName: Schema.String,
  parentResourceId: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Set for sidecar streams: the stored parent resource the peer client is built through.",
    }),
  ),
  parentDisplayName: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "LogCapableResource" });

export const LogCapableResourceList = Schema.Struct({
  resources: Schema.Array(LogCapableResource),
}).annotate({ identifier: "LogCapableResourceList" });

const QueryParams = { orgId: OrgId, queryId: Uuid } as const;

export class LogWorkspacesGroup extends HttpApiGroup.make("logWorkspaces")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: LogWorkspaceQueryList,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List saved log queries")
      .annotate(
        OpenApi.Description,
        "Every saved log-workspace query in the organization: its name, the set of log streams it " +
          "tails, the search expression, the alert flag and the alert pass's last evaluation state. " +
          "Log text itself is fetched per resource via `POST " +
          "/api/org/{orgId}/resources/{pluginId}/{typeId}/logs`.",
      )
      .annotate(SuccessDescription, "The organization's saved log queries"),
    HttpApiEndpoint.get("resources", "/resources", {
      params: OrgParams,
      success: LogCapableResourceList,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List log-capable resources")
      .annotate(
        OpenApi.Description,
        "Synced resources whose rendered detail declares the logs capability (the candidates a " +
          "log workspace can tail) plus sidecar streams reached through a peer integration (pods " +
          "and workloads inside a managed cluster, listed live from the provider and marked with " +
          "`parentResourceId`). Discovered from the plugin contract (never a hardcoded provider " +
          "list), capped at 500 results.",
      )
      .annotate(SuccessDescription, "Resources whose plugin can fetch logs for them"),
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: LogWorkspaceQueryCreate,
      success: LogWorkspaceQuery.pipe(HttpApiSchema.status(201)),
      error: [BadRequest, NotFound, LogWorkspaceQueryConflict],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Save a log workspace query")
      .annotate(
        OpenApi.Description,
        "Save a named multi-resource tail: up to 8 log streams plus a search expression, so the " +
          "workspace can be reopened. With `alertEnabled` the poller evaluates the query every few " +
          "minutes over a bounded tail window and notifies (push/Slack/Teams, `logMatchAlerts` " +
          "trigger) when a line matches, with a cooldown between alerts. Alerting requires a " +
          "non-empty search expression. Audit-logged.",
      )
      .annotate(SuccessDescription, "The created saved query"),
    HttpApiEndpoint.put("update", "/:queryId", {
      params: QueryParams,
      payload: LogWorkspaceQueryUpdate,
      success: LogWorkspaceQuery,
      error: [BadRequest, NotFound, LogWorkspaceQueryUpdateConflict],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Update a saved log query")
      .annotate(
        OpenApi.Description,
        "Edit the name, resource set, search expression and/or the alert toggle. Changing the " +
          "search or the resources resets the alert pass's evaluation state; turning the alert on " +
          "makes the query due for evaluation immediately. Audit-logged.",
      )
      .annotate(SuccessDescription, "The updated saved query"),
    HttpApiEndpoint.delete("delete", "/:queryId", {
      params: QueryParams,
      success: HttpApiSchema.NoContent,
      error: NotFound,
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Delete a saved log query")
      .annotate(
        OpenApi.Description,
        "Remove the saved query and stop any alerting it carried. Audit-logged.",
      )
      .annotate(SuccessDescription, "Deleted"),
  )
  .prefix("/api/org/:orgId/log-workspaces")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Log workspaces") {}

export class LogWorkspacesApi extends withApiDefaults(
  HttpApi.make("logWorkspaces").add(LogWorkspacesGroup),
) {}
