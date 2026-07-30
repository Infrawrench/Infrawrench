import { z } from "../zod";
import {
  strict,
  ErrorResponses,
  Uuid,
  Ok,
  OrgIdParam,
  JsonObject,
  ResourceId,
  IsoDateTime,
} from "../common";
import type { BuildContext } from "../context";

const Dashboard = strict({
  id: Uuid,
  name: z.string(),
  isDefault: z.boolean(),
}).openapi("Dashboard");

const DashboardFull = strict({
  id: Uuid,
  organizationId: Uuid,
  name: z.string(),
  isDefault: z.boolean(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: IsoDateTime.nullable(),
  syncVersion: z.number().int(),
}).openapi("DashboardFull");

const Pin = strict({
  pinId: Uuid,
  resourceId: ResourceId,
  gridX: z.number().int(),
  gridY: z.number().int(),
  gridW: z.number().int(),
  gridH: z.number().int(),
}).openapi("DashboardPin");

const WorkflowPin = strict({
  pinId: Uuid,
  workflowId: Uuid,
  gridX: z.number().int(),
  name: z.string(),
  lastRunAt: IsoDateTime.nullable(),
  lastStatus: z.string().nullable(),
  metrics: z.array(
    strict({
      key: z.string(),
      label: z.string(),
      unit: z.string().nullable(),
      value: z.unknown(),
    }),
  ),
}).openapi("DashboardWorkflowPin");

const WidgetKind = z.enum(["cost_graph", "budget", "custom_graph"]).openapi("DashboardWidgetKind");

const Widget = strict({
  id: Uuid,
  dashboardId: Uuid,
  kind: WidgetKind,
  title: z.string(),
  /** Kind-discriminated config — costGraphConfig or budgetWidgetConfig (see @infrawrench/ui/cost). */
  config: JsonObject,
  gridX: z.number().int(),
  gridY: z.number().int(),
  gridW: z.number().int(),
  gridH: z.number().int(),
}).openapi("DashboardWidget");

const WidgetFull = strict({
  id: Uuid,
  organizationId: Uuid,
  dashboardId: Uuid,
  kind: WidgetKind,
  title: z.string(),
  config: JsonObject,
  gridX: z.number().int(),
  gridY: z.number().int(),
  gridW: z.number().int(),
  gridH: z.number().int(),
  syncVersion: z.number().int(),
  deletedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).openapi("DashboardWidgetFull");

const CreateWidgetRequest = strict({
  dashboardId: Uuid,
  kind: WidgetKind,
  title: z.string().optional(),
  config: JsonObject,
}).openapi("CreateWidgetRequest");

const UpdateWidgetRequest = strict({
  title: z.string().optional(),
  config: JsonObject.optional(),
  gridX: z.number().int().min(0).optional(),
  gridY: z.number().int().min(0).optional(),
  gridW: z.number().int().min(0).optional(),
  gridH: z.number().int().min(0).optional(),
}).openapi("UpdateWidgetRequest");

const DashboardWithPins = strict({
  dashboard: DashboardFull,
  pins: z.array(Pin),
  workflowPins: z.array(WorkflowPin),
  widgets: z.array(Widget),
}).openapi("DashboardWithPins");

const WorkflowPinRequest = strict({
  dashboardId: Uuid,
  workflowId: Uuid,
}).openapi("WorkflowPinRequest");

const ProbeStatus = strict({
  phase: z.enum(["ok", "error"]),
  error: z.string().optional(),
  stats: z.array(JsonObject).optional(),
  sparkline: z
    .array(
      strict({
        timestamp: z.number().openapi({ description: "Unix epoch milliseconds." }),
        value: z.number(),
      }),
    )
    .optional(),
  sparklineLabel: z.string().optional(),
  resourceCounts: z.array(strict({ typeLabel: z.string(), count: z.number().int() })).optional(),
}).openapi("ProbeStatus");

const PinFullResponse = strict({
  pinId: Uuid,
  resourceId: ResourceId,
  gridX: z.number().int(),
  gridY: z.number().int(),
  gridW: z.number().int(),
  gridH: z.number().int(),
  displayName: z.string(),
  pluginId: z.string(),
  resourceTypeId: z.string(),
  accountId: Uuid,
  fieldsJson: JsonObject,
  outputsJson: JsonObject,
  pluginLogoSvg: z.string(),
  pluginDisplayName: z.string(),
  status: ProbeStatus,
}).openapi("PinFull");

const PinRequest = strict({
  dashboardId: Uuid,
  resourceId: ResourceId,
  gridX: z.number().int().optional(),
  gridY: z.number().int().optional(),
}).openapi("PinRequest");

const UnpinRequest = strict({
  dashboardId: Uuid,
  resourceId: ResourceId,
}).openapi("UnpinRequest");

const ReorderRequest = strict({
  /**
   * The whole grid in its new order. Resource pins, workflow pins, and
   * widgets share one drag-reorderable sequence, and each card's `gridX`
   * becomes its index within it.
   */
  cards: z
    .array(strict({ kind: z.enum(["resource", "workflow", "widget"]), id: z.string() }))
    .optional(),
  /** Resource-pins-only form, equivalent to `cards` of kind "resource". */
  resourceIds: z.array(ResourceId).optional(),
}).openapi("ReorderRequest");

const TabTarget = strict({
  kind: z.enum([
    "dashboard",
    "account",
    "resource",
    "agents",
    "costs",
    "workflows",
    "deployments",
    "chat",
  ]),
  dashboardId: Uuid.optional(),
  accountId: Uuid.optional(),
  resourceId: ResourceId.optional(),
  // Omitted for the conversation-list tab, which is always valid.
  conversationId: Uuid.optional(),
}).openapi("TabTarget");

const ValidateTabsRequest = strict({
  tabs: z.array(strict({ id: z.string(), target: TabTarget })),
}).openapi("ValidateTabsRequest");

const ValidateTabsResponse = strict({
  validTabIds: z.array(z.string()),
}).openapi("ValidateTabsResponse");

const ProbeRequest = strict({
  items: z.array(
    strict({
      resourceId: ResourceId,
      accountId: Uuid,
      pluginId: z.string(),
      resourceTypeId: z.string(),
    }),
  ),
}).openapi("ProbeRequest");

const PinRangeMetricSeries = strict({
  label: z.string(),
  unit: z.string().optional(),
  points: z.array(strict({ timestamp: z.number(), value: z.number() })),
}).openapi("PinRangeMetricSeries");

const PinRangeResponse = strict({
  series: z.array(PinRangeMetricSeries),
}).openapi("PinRangeResponse");

export function registerDashboardPaths(ctx: BuildContext) {
  const { registry } = ctx;
  const params = (extra: Record<string, z.ZodType>) => OrgIdParam.extend(extra);

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/dashboards",
    tags: ["Dashboards"],
    summary: "List dashboards",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Dashboards",
        content: { "application/json": { schema: z.array(Dashboard) } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/dashboards",
    tags: ["Dashboards"],
    summary: "Create a dashboard",
    request: {
      params: OrgIdParam,
      body: {
        content: { "application/json": { schema: strict({ name: z.string().min(1) }) } },
        required: true,
      },
    },
    responses: {
      200: { description: "Created", content: { "application/json": { schema: DashboardFull } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/dashboards/default/full",
    tags: ["Dashboards"],
    summary: "Get-or-create the default dashboard with its pins",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Default dashboard",
        content: { "application/json": { schema: DashboardWithPins } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/dashboards/{id}",
    tags: ["Dashboards"],
    summary: "Get a dashboard with its pins",
    request: {
      params: params({ id: Uuid.openapi({ param: { name: "id", in: "path" } }) }),
    },
    responses: {
      200: {
        description: "Dashboard",
        content: { "application/json": { schema: DashboardWithPins } },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/dashboards/{id}/rename",
    tags: ["Dashboards"],
    summary: "Rename a dashboard",
    request: {
      params: params({ id: Uuid.openapi({ param: { name: "id", in: "path" } }) }),
      body: {
        content: { "application/json": { schema: strict({ name: z.string().min(1) }) } },
        required: true,
      },
    },
    responses: { 200: { description: "Renamed", content: { "application/json": { schema: Ok } } } },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/dashboards/{id}",
    tags: ["Dashboards"],
    summary: "Delete a dashboard",
    description: "Cannot delete the default dashboard.",
    request: {
      params: params({ id: Uuid.openapi({ param: { name: "id", in: "path" } }) }),
    },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: Ok } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/dashboards/widgets",
    tags: ["Dashboards"],
    summary: "Add a cost-graph or budget widget to a dashboard",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: CreateWidgetRequest } }, required: true },
    },
    responses: {
      200: { description: "Created", content: { "application/json": { schema: WidgetFull } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/org/{orgId}/dashboards/widgets/{widgetId}",
    tags: ["Dashboards"],
    summary: "Update a widget's title, config, or layout",
    request: {
      params: params({ widgetId: Uuid.openapi({ param: { name: "widgetId", in: "path" } }) }),
      body: { content: { "application/json": { schema: UpdateWidgetRequest } }, required: true },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: WidgetFull } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/dashboards/widgets/{widgetId}",
    tags: ["Dashboards"],
    summary: "Remove a widget from a dashboard",
    request: {
      params: params({ widgetId: Uuid.openapi({ param: { name: "widgetId", in: "path" } }) }),
    },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/dashboards/pin",
    tags: ["Dashboards"],
    summary: "Pin a resource to a dashboard",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: PinRequest } }, required: true },
    },
    responses: {
      200: { description: "Pinned", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/dashboards/{id}/reorder",
    tags: ["Dashboards"],
    summary: "Reorder dashboard cards",
    description:
      "Persists the order of a dashboard's grid. Pass `cards` to order resource pins, " +
      "workflow pins, and widgets as one sequence; `resourceIds` orders resource pins alone.",
    request: {
      params: params({ id: Uuid.openapi({ param: { name: "id", in: "path" } }) }),
      body: { content: { "application/json": { schema: ReorderRequest } }, required: true },
    },
    responses: {
      200: { description: "Reordered", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/dashboards/unpin",
    tags: ["Dashboards"],
    summary: "Unpin a resource",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: UnpinRequest } }, required: true },
    },
    responses: {
      200: { description: "Unpinned", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/dashboards/workflow-pin",
    tags: ["Dashboards"],
    summary: "Pin a workflow's metrics to a dashboard",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: WorkflowPinRequest } }, required: true },
    },
    responses: {
      200: { description: "Pinned", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/dashboards/workflow-unpin",
    tags: ["Dashboards"],
    summary: "Unpin a workflow from a dashboard",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: WorkflowPinRequest } }, required: true },
    },
    responses: {
      200: { description: "Unpinned", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/dashboards/validate-tabs",
    tags: ["Dashboards"],
    summary: "Validate workspace tab targets still exist",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: ValidateTabsRequest } }, required: true },
    },
    responses: {
      200: {
        description: "Result",
        content: { "application/json": { schema: ValidateTabsResponse } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/dashboards/pin/{pinId}",
    tags: ["Dashboards"],
    summary: "Full enriched pin data + cached probe status",
    request: {
      params: params({ pinId: Uuid.openapi({ param: { name: "pinId", in: "path" } }) }),
    },
    responses: {
      200: { description: "Pin", content: { "application/json": { schema: PinFullResponse } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/dashboards/pin/{pinId}/range",
    tags: ["Dashboards"],
    summary: "Historical metric series for a pinned resource",
    description:
      "Returns per-series metric points between fromMs and toMs. The backend auto-routes " +
      "between raw, 1-minute, and 1-hour rollups based on span: ≤2h raw, ≤7d 1m, >7d 1h.",
    request: {
      params: params({ pinId: Uuid.openapi({ param: { name: "pinId", in: "path" } }) }),
      query: strict({
        fromMs: z.coerce.number().int(),
        toMs: z.coerce.number().int(),
      }),
    },
    responses: {
      200: {
        description: "Series",
        content: { "application/json": { schema: PinRangeResponse } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/dashboards/probe",
    tags: ["Dashboards"],
    summary: "Read cached stats/metrics for dashboard cards",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: ProbeRequest } }, required: true },
    },
    responses: {
      200: {
        description: "Probe statuses keyed by resource id",
        content: { "application/json": { schema: z.record(ProbeStatus) } },
      },
    },
  });
}
