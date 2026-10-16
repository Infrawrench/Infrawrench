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
import { CostDateRange } from "./cost-reports";

const Dashboard = strict({
  id: Uuid,
  name: z.string(),
  isDefault: z.boolean().describe("The organization default: the final fallback, never deletable."),
  isResolvedDefault: z
    .boolean()
    .describe(
      "The dashboard the caller lands on: their own default, else their role's, else the " +
        "organization default. Exactly one listed dashboard has it, unless sharing hides it.",
    ),
}).openapi("Dashboard");

const DefaultDashboardSource = z
  .enum(["user", "role", "org"])
  .describe(
    "Which layer the default came from. `user`: the caller's own pick. `role`: the default an " +
      "admin set for the caller's role. `org`: the organization default.",
  )
  .openapi("DefaultDashboardSource");

const DefaultDashboardResolution = strict({
  dashboardId: Uuid,
  dashboardName: z.string(),
  source: DefaultDashboardSource,
  userDefaultDashboardId: Uuid.nullable().describe(
    "The caller's own pick, whether or not it could be used.",
  ),
  roleDefault: strict({ roleId: Uuid, roleName: z.string(), dashboardId: Uuid })
    .nullable()
    .describe(
      "The role default that applies to the caller. When a member holds several roles, custom " +
        "roles win over system roles, then owner, admin, member, then role name and id.",
    ),
  orgDefaultDashboardId: Uuid,
  skipped: z
    .array(z.enum(["user", "role"]))
    .describe(
      "Layers that were set but passed over because the dashboard is no longer shared with the caller.",
    ),
}).openapi("DefaultDashboardResolution");

const RoleDefaultDashboard = strict({
  roleId: Uuid,
  roleName: z.string(),
  isSystem: z.boolean(),
  systemKey: z.string().nullable(),
  dashboardId: Uuid.nullable().describe(
    "Null when the role has no default and its members fall through to the organization default.",
  ),
}).openapi("RoleDefaultDashboard");

const SetDefaultDashboardRequest = strict({ dashboardId: Uuid }).openapi(
  "SetDefaultDashboardRequest",
);

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

const WidgetKind = z
  .enum([
    "cost_graph",
    "cost_report",
    "budget",
    "custom_graph",
    "cost_canvas",
    "realized_savings",
    "kpi",
    "text",
  ])
  .describe(
    "`cost_graph` stores its whole config inline; a one-off card. `cost_report` points at a " +
      "saved cost report by id, so editing the report updates every dashboard showing it. " +
      "`cost_canvas` points at a cost canvas by id (`{version: 1, canvasId}`) the same way. " +
      "`realized_savings` shows the org's realized savings report; its config is only a view " +
      "choice (`grouping`: month | kind | costCentre | account, and `months` back, 1–36). " +
      "`kpi` is one figure with a period-over-period change (see `KpiWidgetConfig`; answered by " +
      "`POST /dashboards/kpi`). `text` is markdown (`{version: 1, markdown}`, up to 20,000 " +
      "characters), rendered without raw HTML.",
  )
  .openapi("DashboardWidgetKind");

const Widget = strict({
  id: Uuid,
  dashboardId: Uuid,
  kind: WidgetKind,
  title: z.string(),
  /** Kind-discriminated config: costGraphConfig or budgetWidgetConfig (see @infrawrench/ui/cost). */
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
  /** Column span: the grid flows in `gridX` order and each card spans this many columns. */
  gridW: z.number().int().min(1).max(12).optional(),
  /** Row span; a row is a minimum height, so content is never clipped. */
  gridH: z.number().int().min(1).max(12).optional(),
}).openapi("UpdateWidgetRequest");

const KpiWidgetSource = z
  .discriminatedUnion("kind", [
    strict({
      kind: z.literal("cost_report"),
      reportId: Uuid,
      measure: z.enum(["cost", "usage", "count", "unit_cost", "business_metric"]),
      aggregation: z.enum(["sum", "daily_average"]),
      usageUnit: z.string().min(1).max(64).optional(),
    }),
    strict({
      kind: z.literal("budget"),
      budgetId: Uuid,
      measure: z.enum(["actual", "forecast", "remaining", "percent_used"]),
    }),
    strict({
      kind: z.literal("commitments"),
      measure: z.enum(["coverage", "utilization", "savings"]),
    }),
    strict({
      kind: z.literal("realized_savings"),
      eventKind: z
        .enum([
          "rightsizing",
          "orphan_deletion",
          "sleep_schedule",
          "commitment",
          "saas_seat",
          "manual",
        ])
        .optional(),
    }),
  ])
  .describe(
    "Where a KPI's figure comes from. A saved report brings its filters, saved filter, cost " +
      "basis and billing-rule choice; `unit_cost` and `business_metric` need a report with a " +
      "business metric attached, `count` a report grouped by a dimension. A budget follows its " +
      "own period. Commitment coverage and utilization are read over the commitments " +
      "service's trailing window; `savings` is the realized savings of kind `commitment`.",
  )
  .openapi("KpiWidgetSource");

const KpiWidgetConfig = strict({
  version: z.literal(1),
  source: KpiWidgetSource,
  dateRange: CostDateRange.optional().describe(
    "The window. Absent follows the source (a report's own range, the last 30 days for " +
      "savings); refused for a budget and for commitment coverage and utilization.",
  ),
  comparePreviousPeriod: z.boolean(),
  upIsGood: z
    .boolean()
    .optional()
    .describe("Which direction the change badge colours as good; absent derives it."),
}).openapi("KpiWidgetConfig");

const DashboardKpiRequest = strict({ config: KpiWidgetConfig }).openapi("DashboardKpiRequest");

const DashboardKpiResult = strict({
  value: z.number().nullable(),
  unit: z.enum(["money", "money_per_unit", "percent", "count", "quantity"]),
  currency: z.string().optional(),
  perUnit: z.string().optional(),
  previous: z.number().nullable(),
  change: z.number().nullable(),
  changePercent: z.number().nullable(),
  upIsGood: z.boolean(),
  from: z.string().optional(),
  to: z.string().optional(),
  previousFrom: z.string().optional(),
  previousTo: z.string().optional(),
  sourceName: z.string().optional(),
  limit: z.number().nullable().optional(),
  note: z.string().optional(),
}).openapi("DashboardKpiResult");

const DashboardWithPins = strict({
  dashboard: DashboardFull,
  resolution: DefaultDashboardResolution.optional().describe(
    "Only on `GET /dashboards/default/full`: why this is the caller's default.",
  ),
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
    // "savings" is retired (the panel is a section of Costs now) but stays
    // accepted here: an older client still sends it, and a strict enum would
    // reject that client's whole tab list rather than the one dead tab.
    "savings",
    "cost-reports",
    "resource-reports",
    "cost-canvases",
    "k8s-efficiency",
    "invoices",
    "graph",
    "logs",
    "changes",
    "expiring",
    "posture",
    "vulnerabilities",
    "compliance",
    "access-review",
    "jit-access",
    "backups",
    "wallboard",
    "calendar",
    "runbooks",
    "query-monitors",
    "dns",
    "iac",
    "environment-diff",
    "environments",
    "ssh-fanout",
    "metric-alerts",
    "probes",
    "status-pages",
    "quotas",
    "price-catalog",
    "incidents",
    "slos",
    "services",
    "delivery",
    "workflows",
    "deployments",
    "settings",
    "chat",
    // One window of a graphical Linux application on a remote host. Always
    // dropped by validate-tabs (its session cannot outlive the page) but
    // accepted so an older client's tab list is not rejected wholesale.
    "linux-app",
  ]),
  dashboardId: Uuid.optional(),
  accountId: Uuid.optional(),
  resourceId: ResourceId.optional(),
  // Omitted for the conversation-list tab, which is always valid.
  conversationId: Uuid.optional(),
  /**
   * Which report the Cost reports tab was last on. Omitted for the list view.
   * Never used to invalidate the tab: the tab is the page, and a deleted
   * report just lands on the list.
   */
  reportId: Uuid.optional(),
  /**
   * Which invoice the Invoices tab was last on. Omitted for the list view.
   * Never used to invalidate the tab: the tab is the page, and a voided or
   * deleted invoice just lands on the list.
   */
  invoiceId: Uuid.optional(),
  /**
   * Which canvas the Canvases tab was last on. Omitted for the list view.
   * Never used to invalidate the tab, like `reportId`.
   */
  canvasId: Uuid.optional(),
  /**
   * Which SLO the SLOs tab was last on. Omitted for the list view. Never used
   * to invalidate the tab: a deleted SLO just lands on the list.
   */
  sloId: Uuid.optional(),
  /**
   * Which service the Services tab was last on. Omitted for the list and the
   * scorecards view. Never used to invalidate the tab: a deleted service just
   * lands on the list.
   */
  serviceId: Uuid.optional(),
  /**
   * The sub-view a tab was on: `scorecards` for the Services tab's scorecard
   * matrix, or a resource tab's `details` / `ssh` / `sftp` / `apps`.
   */
  view: z.enum(["details", "ssh", "sftp", "apps", "scorecards"]).optional(),
  /**
   * Which framework the Compliance tab was last on (`soc2`, `iso27001`).
   * Never used to invalidate the tab: an unknown framework lands on the first.
   */
  framework: z.string().max(64).optional(),
  /** Which app-server session a `linux-app` tab belonged to. */
  sessionId: z.string().max(128).optional(),
  /** Which window of that session. */
  windowId: z.number().int().nonnegative().optional(),
  /** Desktop-file id of the application in that window, when it had one. */
  appId: z.string().max(256).optional(),
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
    path: "/api/org/{orgId}/dashboards/default",
    tags: ["Dashboards"],
    summary: "Which dashboard the caller lands on, and why",
    description:
      "Resolves the caller's default dashboard: their own default, else the default set for " +
      "their role, else the organization default (created as `Home` on first read). A layer " +
      "whose dashboard is no longer shared with the caller is skipped and listed in `skipped`.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Resolution",
        content: { "application/json": { schema: DefaultDashboardResolution } },
      },
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/dashboards/default/me",
    tags: ["Dashboards"],
    summary: "Set my default dashboard",
    description:
      "Overrides the role and organization defaults for the caller in this organization. The " +
      "dashboard must be one the caller can open.",
    request: {
      params: OrgIdParam,
      body: {
        content: { "application/json": { schema: SetDefaultDashboardRequest } },
        required: true,
      },
    },
    responses: {
      200: {
        description: "The caller's resolution after the change",
        content: { "application/json": { schema: DefaultDashboardResolution } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/dashboards/default/me",
    tags: ["Dashboards"],
    summary: "Clear my default dashboard",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "The caller's resolution after the change",
        content: { "application/json": { schema: DefaultDashboardResolution } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/dashboards/role-defaults",
    tags: ["Dashboards"],
    summary: "List each role's default dashboard",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Every role, system and custom, with its default",
        content: { "application/json": { schema: z.array(RoleDefaultDashboard) } },
      },
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/dashboards/role-defaults/{roleId}",
    tags: ["Dashboards"],
    summary: "Set a role's default dashboard",
    description:
      "Members holding the role land on this dashboard unless they picked their own. Refused " +
      "with 422 when the role lacks `dashboards:read` or the dashboard is not shared with the " +
      "role (org-wide or by a role grant). Works for system and custom roles. Needs `org:settings:write` (not `team:role:write`), so an API key can manage it.",
    request: {
      params: params({ roleId: Uuid.openapi({ param: { name: "roleId", in: "path" } }) }),
      body: {
        content: { "application/json": { schema: SetDefaultDashboardRequest } },
        required: true,
      },
    },
    responses: {
      200: {
        description: "The role's default",
        content: { "application/json": { schema: RoleDefaultDashboard } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
      // The role cannot view the dashboard (no `dashboards:read`, or not shared with it).
      422: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/dashboards/role-defaults/{roleId}",
    tags: ["Dashboards"],
    summary: "Clear a role's default dashboard",
    request: {
      params: params({ roleId: Uuid.openapi({ param: { name: "roleId", in: "path" } }) }),
    },
    responses: {
      200: { description: "Cleared", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/dashboards/default/full",
    tags: ["Dashboards"],
    summary: "Get the caller's default dashboard with its pins",
    description:
      "The dashboard `GET /dashboards/default` resolves to, with its cards. The organization " +
      "default is created as `Home` on first read.",
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
    summary: "Add a widget (cost graph, report, budget, KPI, text, ...) to a dashboard",
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
    method: "post",
    path: "/api/org/{orgId}/dashboards/widgets/{widgetId}/duplicate",
    tags: ["Dashboards"],
    summary: "Copy a widget in place",
    description:
      "Inserts a copy with the same kind, config and size directly after the original, moving " +
      "every card behind it one slot along. A copy of a budget or report card is a second view " +
      "onto the same budget or report. Audit-logged.",
    request: {
      params: params({ widgetId: Uuid.openapi({ param: { name: "widgetId", in: "path" } }) }),
    },
    responses: {
      200: { description: "The copy", content: { "application/json": { schema: WidgetFull } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/dashboards/kpi",
    tags: ["Dashboards"],
    summary: "Evaluate a KPI widget config",
    description:
      "Answers one KPI config: a saved card posts its own, an editor posts one to preview it. " +
      "Needs `costs:read`, plus `budgets:read` for a budget source; figures are measured inside " +
      "the caller's cost visibility scope.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: DashboardKpiRequest } }, required: true },
    },
    responses: {
      200: {
        description: "The figure and its comparison",
        content: { "application/json": { schema: DashboardKpiResult } },
      },
      400: ErrorResponses[400],
      403: ErrorResponses[403],
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
