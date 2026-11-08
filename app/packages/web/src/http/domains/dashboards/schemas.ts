/**
 * Dashboards: the request and response schemas `./api.ts` declares.
 *
 * Definitions only. The bodies the editors validate (widget configs, the KPI
 * preview) are the shared schemas in `@infrawrench/ui/schemas`; the rest are
 * documented here and read by the handlers as the routes always read them.
 */
import { Schema } from "effect";
import { DASHBOARD_GRID_LIMITS, DASHBOARD_WIDGET_KINDS } from "@infrawrench/client-core";
import { maxLength, minLength } from "@infrawrench/ui/schemas";
import { IsoDate, IsoDateTime, JsonObject, ResourceId, Uuid } from "../../schemas/common";
import { documentedAs } from "../../schemas/documented";

// --- Dashboards and their default ------------------------------------------

export const Dashboard = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  isDefault: Schema.Boolean.annotate({
    description: "The organization default: the final fallback, never deletable.",
  }),
  isResolvedDefault: Schema.Boolean.annotate({
    description:
      "The dashboard the caller lands on: their own default, else their role's, else the " +
      "organization default. Exactly one listed dashboard has it, unless sharing hides it.",
  }),
}).annotate({ identifier: "Dashboard" });

const DefaultDashboardSource = Schema.Literals(["user", "role", "org"]).annotate({
  identifier: "DefaultDashboardSource",
  description:
    "Which layer the default came from. `user`: the caller's own pick. `role`: the default an " +
    "admin set for the caller's role. `org`: the organization default.",
});

export const DefaultDashboardResolution = Schema.Struct({
  dashboardId: Uuid,
  dashboardName: Schema.String,
  source: DefaultDashboardSource,
  userDefaultDashboardId: Schema.NullOr(Uuid).annotate({
    description: "The caller's own pick, whether or not it could be used.",
  }),
  roleDefault: Schema.NullOr(
    Schema.Struct({ roleId: Uuid, roleName: Schema.String, dashboardId: Uuid }),
  ).annotate({
    description:
      "The role default that applies to the caller. When a member holds several roles, custom " +
      "roles win over system roles, then owner, admin, member, then role name and id.",
  }),
  orgDefaultDashboardId: Uuid,
  skipped: Schema.Array(Schema.Literals(["user", "role"])).annotate({
    description:
      "Layers that were set but passed over because the dashboard is no longer shared with the caller.",
  }),
}).annotate({ identifier: "DefaultDashboardResolution" });

export const RoleDefaultDashboard = Schema.Struct({
  roleId: Uuid,
  roleName: Schema.String,
  isSystem: Schema.Boolean,
  systemKey: Schema.NullOr(Schema.String),
  dashboardId: Schema.NullOr(Uuid).annotate({
    description:
      "Null when the role has no default and its members fall through to the organization default.",
  }),
}).annotate({ identifier: "RoleDefaultDashboard" });

/** Documented; the handler reads `dashboardId` itself ("dashboardId is required"). */
export const SetDefaultDashboardRequest = Schema.Struct({ dashboardId: Uuid }).annotate({
  identifier: "SetDefaultDashboardRequest",
});

/**
 * `POST /dashboards` and `/:id/rename`. The name is documented as non-empty
 * but was never refused for being empty, so only its type is checked.
 */
export const DashboardNameRequest = Schema.Struct({
  name: documentedAs(Schema.String.check(minLength(1))),
});

export const DashboardFull = Schema.Struct({
  id: Uuid,
  organizationId: Uuid,
  name: Schema.String,
  isDefault: Schema.Boolean,
  createdAt: IsoDate,
  updatedAt: IsoDate,
  deletedAt: Schema.NullOr(IsoDate),
  syncVersion: Schema.Int,
}).annotate({ identifier: "DashboardFull" });

// --- Cards -----------------------------------------------------------------

const DashboardPin = Schema.Struct({
  pinId: Uuid,
  resourceId: ResourceId,
  gridX: Schema.Int,
  gridY: Schema.Int,
  gridW: Schema.Int,
  gridH: Schema.Int,
}).annotate({ identifier: "DashboardPin" });

const DashboardWorkflowPin = Schema.Struct({
  pinId: Uuid,
  workflowId: Uuid,
  gridX: Schema.Int,
  name: Schema.String,
  lastRunAt: Schema.NullOr(IsoDateTime),
  lastStatus: Schema.NullOr(Schema.String),
  metrics: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      label: Schema.String,
      unit: Schema.NullOr(Schema.String),
      value: Schema.optionalKey(Schema.Unknown),
    }),
  ),
}).annotate({ identifier: "DashboardWorkflowPin" });

const DashboardWidgetKind = Schema.Literals(DASHBOARD_WIDGET_KINDS).annotate({
  identifier: "DashboardWidgetKind",
  description:
    "`cost_graph` stores its whole config inline; a one-off card. `cost_report` points at a " +
    "saved cost report by id, so editing the report updates every dashboard showing it. " +
    "`cost_canvas` points at a cost canvas by id (`{version: 1, canvasId}`) the same way. " +
    "`realized_savings` shows the org's realized savings report; its config is only a view " +
    "choice (`grouping`: month | kind | costCentre | account, and `months` back, 1–36). " +
    "`kpi` is one figure with a period-over-period change (see `KpiWidgetConfig`; answered by " +
    "`POST /dashboards/kpi`). `text` is markdown (`{version: 1, markdown}`, up to 20,000 " +
    "characters), rendered without raw HTML.",
});

const DashboardWidget = Schema.Struct({
  id: Uuid,
  dashboardId: Uuid,
  kind: DashboardWidgetKind,
  title: Schema.String,
  /** Kind-discriminated config: see `WIDGET_CONFIG_SCHEMAS` in `@infrawrench/ui/schemas`. */
  config: JsonObject,
  gridX: Schema.Int,
  gridY: Schema.Int,
  gridW: Schema.Int,
  gridH: Schema.Int,
}).annotate({ identifier: "DashboardWidget" });

export const DashboardWidgetFull = Schema.Struct({
  id: Uuid,
  organizationId: Uuid,
  dashboardId: Uuid,
  kind: DashboardWidgetKind,
  title: Schema.String,
  config: JsonObject,
  gridX: Schema.Int,
  gridY: Schema.Int,
  gridW: Schema.Int,
  gridH: Schema.Int,
  syncVersion: Schema.Int,
  deletedAt: Schema.NullOr(IsoDate),
  createdAt: IsoDate,
  updatedAt: IsoDate,
}).annotate({ identifier: "DashboardWidgetFull" });

/** Documented; the handler checks the kind, the dashboard and the config itself, in that order. */
export const CreateWidgetRequest = Schema.Struct({
  dashboardId: Uuid,
  kind: DashboardWidgetKind,
  title: Schema.optionalKey(Schema.String),
  config: JsonObject,
}).annotate({ identifier: "CreateWidgetRequest" });

/** Documented; the handler validates each field, answering a bad span with its own sentence. */
export const UpdateWidgetRequest = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  config: Schema.optionalKey(JsonObject),
  gridX: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  gridY: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  /** Column span: the grid flows in `gridX` order and each card spans this many columns. */
  gridW: Schema.optionalKey(
    Schema.Int.check(
      Schema.isBetween({
        minimum: DASHBOARD_GRID_LIMITS.minSpan,
        maximum: DASHBOARD_GRID_LIMITS.maxWidth,
      }),
    ),
  ),
  /** Row span; a row is a minimum height, so content is never clipped. */
  gridH: Schema.optionalKey(
    Schema.Int.check(
      Schema.isBetween({
        minimum: DASHBOARD_GRID_LIMITS.minSpan,
        maximum: DASHBOARD_GRID_LIMITS.maxHeight,
      }),
    ),
  ),
}).annotate({ identifier: "UpdateWidgetRequest" });

export const DashboardKpiResult = Schema.Struct({
  value: Schema.NullOr(Schema.Finite),
  unit: Schema.Literals(["money", "money_per_unit", "percent", "count", "quantity"]),
  currency: Schema.optionalKey(Schema.String),
  perUnit: Schema.optionalKey(Schema.String),
  previous: Schema.NullOr(Schema.Finite),
  change: Schema.NullOr(Schema.Finite),
  changePercent: Schema.NullOr(Schema.Finite),
  upIsGood: Schema.Boolean,
  from: Schema.optionalKey(Schema.String),
  to: Schema.optionalKey(Schema.String),
  previousFrom: Schema.optionalKey(Schema.String),
  previousTo: Schema.optionalKey(Schema.String),
  sourceName: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  note: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "DashboardKpiResult" });

export const DashboardWithPins = Schema.Struct({
  dashboard: DashboardFull,
  resolution: Schema.optionalKey(DefaultDashboardResolution).annotateKey({
    description: "Only on `GET /dashboards/default/full`: why this is the caller's default.",
  }),
  pins: Schema.Array(DashboardPin),
  workflowPins: Schema.Array(DashboardWorkflowPin),
  widgets: Schema.Array(DashboardWidget),
}).annotate({ identifier: "DashboardWithPins" });

export const WorkflowPinRequest = Schema.Struct({
  dashboardId: Uuid,
  workflowId: Uuid,
}).annotate({ identifier: "WorkflowPinRequest" });

export const ProbeStatus = Schema.Struct({
  phase: Schema.Literals(["ok", "error"]),
  error: Schema.optionalKey(Schema.String),
  stats: Schema.optionalKey(Schema.Array(JsonObject)),
  sparkline: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        timestamp: Schema.Finite.annotate({ description: "Unix epoch milliseconds." }),
        value: Schema.Finite,
      }),
    ),
  ),
  sparklineLabel: Schema.optionalKey(Schema.String),
  resourceCounts: Schema.optionalKey(
    Schema.Array(Schema.Struct({ typeLabel: Schema.String, count: Schema.Int })),
  ),
}).annotate({ identifier: "ProbeStatus" });

export const PinFull = Schema.Struct({
  pinId: Uuid,
  resourceId: ResourceId,
  gridX: Schema.Int,
  gridY: Schema.Int,
  gridW: Schema.Int,
  gridH: Schema.Int,
  displayName: Schema.String,
  pluginId: Schema.String,
  resourceTypeId: Schema.String,
  accountId: Uuid,
  fieldsJson: JsonObject,
  outputsJson: JsonObject,
  pluginLogoSvg: Schema.String,
  iconKey: Schema.optionalKey(Schema.String),
  /** The fields this type marked to show on the card. */
  showcase: Schema.optionalKey(
    Schema.Array(Schema.Struct({ key: Schema.String, label: Schema.String })),
  ),
  pluginDisplayName: Schema.String,
  status: ProbeStatus,
}).annotate({ identifier: "PinFull" });

export const PinRequest = Schema.Struct({
  dashboardId: Uuid,
  resourceId: ResourceId,
  gridX: Schema.optionalKey(Schema.Int),
  gridY: Schema.optionalKey(Schema.Int),
}).annotate({ identifier: "PinRequest" });

export const UnpinRequest = Schema.Struct({
  dashboardId: Uuid,
  resourceId: ResourceId,
}).annotate({ identifier: "UnpinRequest" });

export const ReorderRequest = Schema.Struct({
  /**
   * The whole grid in its new order. Resource pins, workflow pins, and
   * widgets share one drag-reorderable sequence, and each card's `gridX`
   * becomes its index within it.
   */
  cards: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        kind: Schema.Literals(["resource", "workflow", "widget"]),
        id: Schema.String,
      }),
    ),
  ),
  /** Resource-pins-only form, equivalent to `cards` of kind "resource". */
  resourceIds: Schema.optionalKey(Schema.Array(ResourceId)),
}).annotate({ identifier: "ReorderRequest" });

// --- Workspace tabs --------------------------------------------------------

/**
 * Every workspace tab kind a client may restore. `savings` is retired (the
 * panel is a section of Costs now) but stays accepted: an older client still
 * sends it, and a strict enum would reject that client's whole tab list
 * rather than the one dead tab. `linux-app` is one window of a graphical
 * Linux application on a remote host: always dropped (its session cannot
 * outlive the page) but accepted for the same reason.
 */
const TAB_KINDS = [
  "dashboard",
  "account",
  "resource",
  "agents",
  "costs",
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
  "linux-app",
] as const;

const TabTarget = Schema.Struct({
  kind: Schema.Literals(TAB_KINDS),
  dashboardId: Schema.optionalKey(Uuid),
  accountId: Schema.optionalKey(Uuid),
  resourceId: Schema.optionalKey(ResourceId),
  /** Omitted for the conversation-list tab, which is always valid. */
  conversationId: Schema.optionalKey(Uuid),
  /**
   * Which report the Cost reports tab was last on. Omitted for the list view.
   * Never used to invalidate the tab: the tab is the page, and a deleted
   * report just lands on the list.
   */
  reportId: Schema.optionalKey(Uuid),
  /**
   * Which invoice the Invoices tab was last on. Omitted for the list view.
   * Never used to invalidate the tab: the tab is the page, and a voided or
   * deleted invoice just lands on the list.
   */
  invoiceId: Schema.optionalKey(Uuid),
  /**
   * Which canvas the Canvases tab was last on. Omitted for the list view.
   * Never used to invalidate the tab, like `reportId`.
   */
  canvasId: Schema.optionalKey(Uuid),
  /**
   * Which SLO the SLOs tab was last on. Omitted for the list view. Never used
   * to invalidate the tab: a deleted SLO just lands on the list.
   */
  sloId: Schema.optionalKey(Uuid),
  /**
   * Which service the Services tab was last on. Omitted for the list and the
   * scorecards view. Never used to invalidate the tab: a deleted service just
   * lands on the list.
   */
  serviceId: Schema.optionalKey(Uuid),
  /**
   * The sub-view a tab was on: `scorecards` for the Services tab's scorecard
   * matrix, or a resource tab's `details` / `ssh` / `sftp` / `apps`.
   */
  view: Schema.optionalKey(Schema.Literals(["details", "ssh", "sftp", "apps", "scorecards"])),
  /**
   * Which framework the Compliance tab was last on (`soc2`, `iso27001`).
   * Never used to invalidate the tab: an unknown framework lands on the first.
   */
  framework: Schema.optionalKey(Schema.String.check(maxLength(64))),
  /** Which app-server session a `linux-app` tab belonged to. */
  sessionId: Schema.optionalKey(Schema.String.check(maxLength(128))),
  /** Which window of that session. */
  windowId: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  /** Desktop-file id of the application in that window, when it had one. */
  appId: Schema.optionalKey(Schema.String.check(maxLength(256))),
}).annotate({ identifier: "TabTarget" });

export const ValidateTabsRequest = Schema.Struct({
  tabs: Schema.Array(Schema.Struct({ id: Schema.String, target: TabTarget })),
}).annotate({ identifier: "ValidateTabsRequest" });

export const ValidateTabsResponse = Schema.Struct({
  validTabIds: Schema.Array(Schema.String),
}).annotate({ identifier: "ValidateTabsResponse" });

// --- Cached probe data -----------------------------------------------------

export const ProbeRequest = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      resourceId: ResourceId,
      accountId: Uuid,
      pluginId: Schema.String,
      resourceTypeId: Schema.String,
    }),
  ),
}).annotate({ identifier: "ProbeRequest" });

const PinRangeMetricSeries = Schema.Struct({
  label: Schema.String,
  unit: Schema.optionalKey(Schema.String),
  points: Schema.Array(Schema.Struct({ timestamp: Schema.Finite, value: Schema.Finite })),
}).annotate({ identifier: "PinRangeMetricSeries" });

export const PinRangeResponse = Schema.Struct({
  series: Schema.Array(PinRangeMetricSeries),
}).annotate({ identifier: "PinRangeResponse" });
