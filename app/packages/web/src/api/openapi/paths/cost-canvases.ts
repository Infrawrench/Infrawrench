import { z } from "../zod";
import { strict, ErrorResponses, JsonObject, Ok, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";
import { CostDateRange, ReportCostFilter } from "./cost-reports";
import { Cadence, ReportDeliveryTargets } from "./cost-report-notifications";
import {
  AttachPdf,
  DashboardNotificationInput,
  DashboardNotificationSendResult,
  PdfBody,
  TzQuery,
} from "./dashboard-notifications";

const BlockId = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9_-]+$/)
  .describe("Stable within the spec; text blocks reference KPI ids as `{{id}}`.");
const Title = z.string().min(1).max(120);
const CostBasis = z.enum(["cash", "amortized", "blended"]);
const Filters = z.array(ReportCostFilter).max(20).optional();

const KpiMetric = z
  .union([
    strict({
      type: z.literal("spend"),
      dateRange: CostDateRange,
      filters: Filters,
      savedFilterId: z.string().optional(),
      costBasis: CostBasis.optional(),
      adjusted: z.boolean().optional(),
    }),
    strict({
      type: z.literal("unit_cost"),
      businessMetricId: z.string().describe("A business metric id (see /business-metrics)."),
      dateRange: CostDateRange,
      filters: Filters,
      savedFilterId: z.string().optional(),
      costBasis: CostBasis.optional(),
    }),
    strict({
      type: z.literal("forecast"),
      filters: Filters,
      savedFilterId: z.string().optional(),
    }),
    strict({ type: z.literal("budget"), budgetId: z.string() }),
    strict({ type: z.literal("anomaly_count"), days: z.number().int().min(1).max(90) }),
  ])
  .openapi("CostCanvasKpiMetric");

const TableQuery = strict({
  dateRange: CostDateRange,
  binning: z.enum(["none", "daily", "weekly", "monthly"]),
  groupBy: z.enum([
    "provider",
    "account",
    "service",
    "region",
    "resource",
    "tag",
    "charge_type",
    "commitment",
  ]),
  groupByTagKey: z.string().optional(),
  filters: Filters,
  savedFilterId: z.string().optional(),
  costBasis: CostBasis.optional(),
  adjusted: z.boolean().optional(),
  topN: z.number().int().min(1).max(50).optional(),
}).openapi("CostCanvasTableQuery");

const CostCanvasBlock = z
  .union([
    strict({
      id: BlockId,
      kind: z.literal("text"),
      text: z
        .string()
        .min(1)
        .max(2000)
        .describe("Short narrative; `{{kpiId}}` / `{{kpiId.change}}` render that KPI's figure."),
    }),
    strict({
      id: BlockId,
      kind: z.literal("kpi"),
      title: Title,
      metric: KpiMetric,
      comparePreviousPeriod: z.boolean().optional(),
    }),
    strict({
      id: BlockId,
      kind: z.literal("chart"),
      title: Title,
      config: JsonObject.describe(
        "A cost graph config, the same object a `cost_graph` dashboard widget stores.",
      ),
    }),
    strict({ id: BlockId, kind: z.literal("table"), title: Title, query: TableQuery }),
    strict({
      id: BlockId,
      kind: z.literal("budgets"),
      title: Title,
      budgetIds: z.array(z.string()).max(12).optional(),
    }),
    strict({
      id: BlockId,
      kind: z.literal("anomalies"),
      title: Title,
      days: z.number().int().min(1).max(90).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    strict({
      id: BlockId,
      kind: z.literal("cost_report"),
      title: Title.optional(),
      reportId: z.string(),
    }),
    strict({
      id: BlockId,
      kind: z.literal("custom_graph"),
      title: Title.optional(),
      graphId: z.string(),
    }),
  ])
  .openapi("CostCanvasBlock");

const CostCanvasSpec = strict({
  version: z.literal(1),
  blocks: z.array(CostCanvasBlock).max(24),
})
  .describe(
    "The structured query spec. It holds queries, never numbers: running the canvas " +
      "re-executes every block, so a refresh needs no model call. Validated strictly on write; " +
      "there is no field that takes a query string or SQL.",
  )
  .openapi("CostCanvasSpec");

const CostCanvasInput = strict({
  name: z.string().min(1).max(120),
  description: z.string().max(1000).optional(),
  spec: CostCanvasSpec,
}).openapi("CostCanvasInput");

const CostCanvasDraftInput = strict({
  prompt: z.string().min(1).max(4000).describe("What the report should show, in plain words."),
  name: z.string().min(1).max(120).optional(),
  model: z.string().optional().describe("A chat model id; the chat default when absent."),
}).openapi("CostCanvasDraftInput");

const CostCanvasPlacement = strict({
  widgetId: Uuid,
  dashboardId: Uuid,
  dashboardName: z.string(),
}).openapi("CostCanvasPlacement");

const CostCanvas = strict({
  id: Uuid,
  name: z.string(),
  description: z.string().nullable(),
  spec: CostCanvasSpec,
  prompt: z.string().nullable(),
  conversationId: Uuid.nullable().describe(
    "The caller's latest unarchived chat conversation for this canvas; per user.",
  ),
  createdByUserId: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  placements: z.array(CostCanvasPlacement),
}).openapi("CostCanvas");

const CostCanvasRunResult = strict({
  canvasId: Uuid.nullable(),
  name: z.string(),
  ranAt: IsoDateTime,
  displayCurrency: z.string().nullable(),
  blocks: z
    .array(JsonObject)
    .describe(
      "One result per block, in spec order, each `{id, kind, ...}` with an `error` string when " +
        "that block failed: `kpi` carries `kpi {value, unit, currency, previous, " +
        "changePercent, from, to, note}`, `table` carries `table {columns, rows, currency}`, " +
        "`chart`/`cost_report` carry the cost or unit-cost query response when chart data was " +
        "requested, `budgets`, `anomalies` and `custom_graph` carry their rows or render spec, " +
        "and `text` carries the narrative with KPI tokens filled in.",
    ),
}).openapi("CostCanvasRunResult");

const RunBody = strict({
  includeChartData: z
    .boolean()
    .optional()
    .describe("Include full chart series. Default true; the live UI passes false."),
});

const CostCanvasNotification = strict({
  id: Uuid,
  costCanvasId: Uuid,
  cadence: Cadence,
  sendDay: z.number().int(),
  sendDayOfMonth: z.number().int(),
  hour: z.number().int(),
  timezone: z.string(),
  slackChannelIds: z.array(z.string()),
  teamsWebhookIds: z.array(z.string()),
  emailRecipients: z.array(z.string()),
  enabled: z.boolean(),
  attachPdf: AttachPdf,
  nextSendAt: IsoDateTime.nullable(),
  lastSentAt: IsoDateTime.nullable(),
  lastStatus: z.enum(["pending", "succeeded", "partial", "failed", "no_targets"]).nullable(),
  lastError: z.string().nullable(),
  createdByUserId: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).openapi("CostCanvasNotification");

export function registerCostCanvasPaths(ctx: BuildContext) {
  const { registry } = ctx;
  const tags = ["Cost canvases"];
  const params = (extra: Record<string, z.ZodType>) => OrgIdParam.extend(extra);
  const idParam = () => params({ id: Uuid.openapi({ param: { name: "id", in: "path" } }) });
  const notifParam = () =>
    params({
      id: Uuid.openapi({ param: { name: "id", in: "path" } }),
      notificationId: Uuid.openapi({ param: { name: "notificationId", in: "path" } }),
    });
  const json = (schema: z.ZodType) => ({ content: { "application/json": { schema } } });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/cost-canvases",
    tags,
    summary: "List cost canvases",
    request: { params: OrgIdParam },
    responses: { 200: { description: "Canvases", ...json(z.array(CostCanvas)) } },
  });
  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/cost-canvases",
    tags,
    summary: "Create a cost canvas from a spec",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: CostCanvasInput } }, required: true },
    },
    responses: { 200: { description: "Created", ...json(CostCanvas) }, 400: ErrorResponses[400] },
  });
  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/cost-canvases/draft",
    tags,
    summary: "Start a canvas from a description",
    description:
      "Creates an empty canvas and a chat conversation linked to it. Send `prompt` as the " +
      "conversation's first message (`POST /chat/conversations/{id}/messages`); the agent " +
      "writes the spec. Needs `chat:write` as well as `costs:write`.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: CostCanvasDraftInput } }, required: true },
    },
    responses: { 200: { description: "Created", ...json(CostCanvas) }, 400: ErrorResponses[400] },
  });
  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/cost-canvases/preview",
    tags,
    summary: "Run an unsaved canvas spec",
    request: {
      params: OrgIdParam,
      body: {
        content: {
          "application/json": {
            schema: strict({
              spec: CostCanvasSpec,
              name: z.string().optional(),
              includeChartData: z.boolean().optional(),
            }),
          },
        },
        required: true,
      },
    },
    responses: {
      200: { description: "Result", ...json(CostCanvasRunResult) },
      400: ErrorResponses[400],
    },
  });
  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/cost-canvases/{id}",
    tags,
    summary: "Get a cost canvas",
    request: { params: idParam() },
    responses: { 200: { description: "Canvas", ...json(CostCanvas) }, 404: ErrorResponses[404] },
  });
  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/cost-canvases/{id}",
    tags,
    summary: "Replace a cost canvas",
    request: {
      params: idParam(),
      body: { content: { "application/json": { schema: CostCanvasInput } }, required: true },
    },
    responses: {
      200: { description: "Updated", ...json(CostCanvas) },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });
  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/cost-canvases/{id}",
    tags,
    summary: "Delete a cost canvas",
    description: "Soft delete. Its dashboard cards and delivery schedules go with it.",
    request: { params: idParam() },
    responses: { 200: { description: "Deleted", ...json(Ok) }, 404: ErrorResponses[404] },
  });
  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/cost-canvases/{id}/run",
    tags,
    summary: "Run (refresh) a cost canvas",
    description: "Re-executes every block's query. Deterministic; no model call.",
    request: {
      params: idParam(),
      body: { content: { "application/json": { schema: RunBody } }, required: false },
    },
    responses: {
      200: { description: "Result", ...json(CostCanvasRunResult) },
      404: ErrorResponses[404],
    },
  });
  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/cost-canvases/{id}/conversation",
    tags,
    summary: "Open the caller's editing conversation for a canvas",
    request: {
      params: idParam(),
      body: {
        content: {
          "application/json": {
            schema: strict({ model: z.string().optional(), fresh: z.boolean().optional() }),
          },
        },
        required: false,
      },
    },
    responses: {
      200: { description: "Conversation", ...json(strict({ conversationId: Uuid })) },
      404: ErrorResponses[404],
    },
  });
  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/cost-canvases/{id}/pdf",
    tags,
    summary: "Export a cost canvas as a PDF",
    request: { params: idParam(), query: TzQuery },
    responses: {
      200: { description: "The PDF, as an attachment", content: PdfBody },
      404: ErrorResponses[404],
    },
  });
  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/cost-canvases/{id}/notifications",
    tags,
    summary: "List a canvas's delivery schedules",
    request: { params: idParam() },
    responses: {
      200: { description: "Schedules", ...json(z.array(CostCanvasNotification)) },
      404: ErrorResponses[404],
    },
  });
  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/cost-canvases/{id}/notifications/targets",
    tags,
    summary: "List the destinations a canvas schedule can deliver to",
    request: { params: idParam() },
    responses: {
      200: { description: "Targets", ...json(ReportDeliveryTargets) },
      404: ErrorResponses[404],
    },
  });
  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/cost-canvases/{id}/notifications",
    tags,
    summary: "Create a canvas delivery schedule",
    request: {
      params: idParam(),
      body: {
        content: { "application/json": { schema: DashboardNotificationInput } },
        required: true,
      },
    },
    responses: {
      200: { description: "Created", ...json(CostCanvasNotification) },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });
  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/cost-canvases/{id}/notifications/{notificationId}",
    tags,
    summary: "Replace a canvas delivery schedule",
    request: {
      params: notifParam(),
      body: {
        content: { "application/json": { schema: DashboardNotificationInput } },
        required: true,
      },
    },
    responses: {
      200: { description: "Updated", ...json(CostCanvasNotification) },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });
  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/cost-canvases/{id}/notifications/{notificationId}",
    tags,
    summary: "Delete a canvas delivery schedule",
    request: { params: notifParam() },
    responses: { 200: { description: "Deleted", ...json(Ok) }, 404: ErrorResponses[404] },
  });
  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/cost-canvases/{id}/notifications/{notificationId}/send",
    tags,
    summary: "Send a canvas delivery now",
    request: { params: notifParam() },
    responses: {
      200: { description: "Outcome", ...json(DashboardNotificationSendResult) },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });
}
