import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const SearchExpression = z
  .string()
  .max(500)
  .openapi({
    description:
      "The search expression. Empty matches every line; `/pattern/` (optionally `/pattern/i`) " +
      "is a regular expression; otherwise whitespace-separated terms that must ALL appear in a " +
      'line (case-insensitive), with `"quoted phrases"` and `-term` negation.',
    example: 'error -healthcheck "connection reset"',
  });

export function registerLogWorkspacePaths(ctx: BuildContext) {
  const { registry, enums } = ctx;

  const LogStreamSelector = strict({
    resourceId: z.string().describe("Infrawrench resource id of the stream to tail."),
    accountId: Uuid,
    pluginId: enums.PluginId,
    resourceTypeId: z.string(),
    container: z
      .string()
      .optional()
      .describe("Container to fetch when the resource has more than one; omit for the default."),
  }).openapi("LogStreamSelector");

  const LogWorkspaceQuery = strict({
    id: Uuid,
    name: z.string(),
    resources: z.array(LogStreamSelector),
    search: SearchExpression,
    alertEnabled: z
      .boolean()
      .describe("When true the poller periodically evaluates the query and alerts on match."),
    lastEvalAt: IsoDateTime.nullable().describe(
      "Last time the alert pass evaluated this query; null until it has run.",
    ),
    lastMatchAt: IsoDateTime.nullable().describe(
      "Last evaluation that found at least one matching line.",
    ),
    lastAlertedAt: IsoDateTime.nullable().describe(
      "Last dispatched notification — the cooldown anchor.",
    ),
    lastEvalError: z.string().nullable().describe("Failure detail from the last evaluation."),
    lastMatchSample: z
      .string()
      .nullable()
      .describe("Truncated sample of the most recent matching line."),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  }).openapi("LogWorkspaceQuery");

  const LogWorkspaceQueryList = strict({
    queries: z.array(LogWorkspaceQuery),
  }).openapi("LogWorkspaceQueryList");

  const LogWorkspaceQueryCreate = strict({
    name: z.string().min(1).max(120),
    resources: z.array(LogStreamSelector).min(1).max(8),
    search: SearchExpression,
    alertEnabled: z.boolean().optional(),
  }).openapi("LogWorkspaceQueryCreate");

  const LogWorkspaceQueryUpdate = strict({
    name: z.string().min(1).max(120).optional(),
    resources: z.array(LogStreamSelector).min(1).max(8).optional(),
    search: SearchExpression.optional(),
    alertEnabled: z.boolean().optional(),
  }).openapi("LogWorkspaceQueryUpdate");

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/log-workspaces",
    tags: ["Log workspaces"],
    summary: "List saved log queries",
    description:
      "Every saved log-workspace query in the organization: its name, the set of log streams it " +
      "tails, the search expression, the alert flag and the alert pass's last evaluation state. " +
      "Log text itself is fetched per resource via `POST " +
      "/api/org/{orgId}/resources/{pluginId}/{typeId}/logs`.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "The organization's saved log queries",
        content: { "application/json": { schema: LogWorkspaceQueryList } },
      },
    },
  });

  const LogCapableResource = strict({
    resourceId: z.string(),
    accountId: Uuid,
    accountName: z.string(),
    pluginId: enums.PluginId,
    resourceTypeId: z.string(),
    displayName: z.string(),
  }).openapi("LogCapableResource");

  const LogCapableResourceList = strict({
    resources: z.array(LogCapableResource),
  }).openapi("LogCapableResourceList");

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/log-workspaces/resources",
    tags: ["Log workspaces"],
    summary: "List log-capable resources",
    description:
      "Synced resources whose rendered detail declares the logs capability — the candidates a " +
      "log workspace can tail. Discovered from the plugin contract (never a hardcoded provider " +
      "list), capped at 500 results.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Resources whose plugin can fetch logs for them",
        content: { "application/json": { schema: LogCapableResourceList } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/log-workspaces",
    tags: ["Log workspaces"],
    summary: "Save a log workspace query",
    description:
      "Save a named multi-resource tail: up to 8 log streams plus a search expression, so the " +
      "workspace can be reopened. With `alertEnabled` the poller evaluates the query every few " +
      "minutes over a bounded tail window and notifies (push/Slack/Teams, `logMatchAlerts` " +
      "trigger) when a line matches, with a cooldown between alerts. Alerting requires a " +
      "non-empty search expression. Audit-logged.",
    request: {
      params: OrgIdParam,
      body: {
        content: { "application/json": { schema: LogWorkspaceQueryCreate } },
        required: true,
      },
    },
    responses: {
      201: {
        description: "The created saved query",
        content: { "application/json": { schema: LogWorkspaceQuery } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
      409: {
        description: "A saved query with this name already exists",
        content: {
          "application/json": {
            schema: strict({ error: z.string() }).openapi("LogWorkspaceQueryConflict"),
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/log-workspaces/{queryId}",
    tags: ["Log workspaces"],
    summary: "Update a saved log query",
    description:
      "Edit the name, resource set, search expression and/or the alert toggle. Changing the " +
      "search or the resources resets the alert pass's evaluation state; turning the alert on " +
      "makes the query due for evaluation immediately. Audit-logged.",
    request: {
      params: OrgIdParam.extend({ queryId: Uuid }),
      body: {
        content: { "application/json": { schema: LogWorkspaceQueryUpdate } },
        required: true,
      },
    },
    responses: {
      200: {
        description: "The updated saved query",
        content: { "application/json": { schema: LogWorkspaceQuery } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
      409: {
        description: "A saved query with this name already exists",
        content: {
          "application/json": {
            schema: strict({ error: z.string() }).openapi("LogWorkspaceQueryUpdateConflict"),
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/log-workspaces/{queryId}",
    tags: ["Log workspaces"],
    summary: "Delete a saved log query",
    description: "Remove the saved query and stop any alerting it carried. Audit-logged.",
    request: { params: OrgIdParam.extend({ queryId: Uuid }) },
    responses: {
      204: { description: "Deleted" },
      404: ErrorResponses[404],
    },
  });
}
