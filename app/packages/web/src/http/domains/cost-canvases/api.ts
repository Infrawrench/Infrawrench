/**
 * Cost canvases, `/api/org/:orgId/cost-canvases`, the endpoint definitions.
 *
 * A canvas is a saved, structured report spec the chat agent writes from a
 * natural-language description: CRUD, `POST /draft` (start a canvas and its
 * conversation from a prompt), `POST /:id/run` (re-run every query; no model
 * call), `POST /preview` (run an unsaved spec), `GET /:id/pdf`, and delivery
 * schedules under `/:id/notifications`.
 *
 * Reads are `costs:read`, writes `costs:write`, like reports. Starting a
 * conversation also needs `chat:write`, checked in the handler. Schedule
 * writes, targets and "Send now" are `org:settings:write`, as for every other
 * delivery schedule. Canvas bodies are model-authored and strict, so the
 * handlers decode them themselves and answer a refusal as one readable
 * sentence (`Invalid canvas: ...`), the agent's and the editor's 400.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { CostCanvasDraftInput, CostCanvasInput, CostCanvasSpec } from "@infrawrench/ui/schemas";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, Forbidden, NotFound } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import {
  IsoDateTime,
  JsonObject,
  Ok,
  OrgIdParams,
  OrgParams,
  OrgId,
  Uuid,
} from "../../schemas/common";
import { optionalRequestBody } from "../../schemas/documented";
import {
  attachPdfDescription,
  DashboardNotificationInput,
  DashboardNotificationSendResult,
  DeliveryCadence,
  DeliveryLastStatus,
  PdfDocument,
  ReportDeliveryTargets,
  TzQuery,
} from "../../schemas/report-delivery";

const CostCanvasPlacement = Schema.Struct({
  widgetId: Uuid,
  dashboardId: Uuid,
  dashboardName: Schema.String,
}).annotate({ identifier: "CostCanvasPlacement" });

export const CostCanvas = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  spec: CostCanvasSpec,
  prompt: Schema.NullOr(Schema.String),
  conversationId: Schema.NullOr(Uuid).annotate({
    description: "The caller's latest unarchived chat conversation for this canvas; per user.",
  }),
  createdByUserId: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  placements: Schema.Array(CostCanvasPlacement),
}).annotate({ identifier: "CostCanvas" });

export const CostCanvasRunResult = Schema.Struct({
  canvasId: Schema.NullOr(Uuid),
  name: Schema.String,
  ranAt: IsoDateTime,
  displayCurrency: Schema.NullOr(Schema.String),
  blocks: Schema.Array(JsonObject).annotate({
    description:
      "One result per block, in spec order, each `{id, kind, ...}` with an `error` string when " +
      "that block failed: `kpi` carries `kpi {value, unit, currency, previous, " +
      "changePercent, from, to, note}`, `table` carries `table {columns, rows, currency}`, " +
      "`chart`/`cost_report` carry the cost or unit-cost query response when chart data was " +
      "requested, `budgets`, `anomalies` and `custom_graph` carry their rows or render spec, " +
      "and `text` carries the narrative with KPI tokens filled in.",
  }),
}).annotate({ identifier: "CostCanvasRunResult" });

/** `POST /preview`: an unsaved spec. Documented; the handler reads it field by field. */
const PreviewBody = Schema.Struct({
  spec: CostCanvasSpec,
  name: Schema.optionalKey(Schema.String),
  includeChartData: Schema.optionalKey(Schema.Boolean),
});

/** `POST /:id/run`: optional, and read as the route always read it. */
const RunBody = Schema.Struct({
  includeChartData: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Include full chart series. Default true; the live UI passes false.",
    }),
  ),
});

const ConversationBody = Schema.Struct({
  model: Schema.optionalKey(Schema.String),
  fresh: Schema.optionalKey(Schema.Boolean),
});

export const CanvasConversation = Schema.Struct({ conversationId: Uuid });

export const CostCanvasNotification = Schema.Struct({
  id: Uuid,
  costCanvasId: Uuid,
  cadence: DeliveryCadence,
  sendDay: Schema.Int,
  sendDayOfMonth: Schema.Int,
  hour: Schema.Int,
  timezone: Schema.String,
  slackChannelIds: Schema.Array(Schema.String),
  teamsWebhookIds: Schema.Array(Schema.String),
  emailRecipients: Schema.Array(Schema.String),
  enabled: Schema.Boolean,
  attachPdf: Schema.Boolean.annotate({ description: attachPdfDescription }),
  nextSendAt: Schema.NullOr(IsoDateTime),
  lastSentAt: Schema.NullOr(IsoDateTime),
  lastStatus: Schema.NullOr(DeliveryLastStatus),
  lastError: Schema.NullOr(Schema.String),
  createdByUserId: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "CostCanvasNotification" });

const ScheduleParams = { orgId: OrgId, id: Uuid, notificationId: Uuid } as const;

export class CostCanvasesGroup extends HttpApiGroup.make("costCanvases")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: Schema.Array(CostCanvas),
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "List cost canvases")
      .annotate(SuccessDescription, "Canvases"),
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: CostCanvasInput,
      success: CostCanvas,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Create a cost canvas from a spec")
      .annotate(SuccessDescription, "Created"),
    // `chat:write` as well, checked in the handler: the gate takes one permission.
    HttpApiEndpoint.post("draft", "/draft", {
      params: OrgParams,
      payload: CostCanvasDraftInput,
      success: CostCanvas,
      error: [BadRequest, Forbidden],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Start a canvas from a description")
      .annotate(
        OpenApi.Description,
        "Creates an empty canvas and a chat conversation linked to it. Send `prompt` as the " +
          "conversation's first message (`POST /chat/conversations/{id}/messages`); the agent " +
          "writes the spec. Needs `chat:write` as well as `costs:write`.",
      )
      .annotate(SuccessDescription, "Created")
      .annotate(InvalidRequestMessage, "Invalid draft"),
    HttpApiEndpoint.post("preview", "/preview", {
      params: OrgParams,
      payload: PreviewBody,
      success: CostCanvasRunResult,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Run an unsaved canvas spec")
      .annotate(SuccessDescription, "Result"),
    HttpApiEndpoint.get("get", "/:id", {
      params: OrgIdParams,
      success: CostCanvas,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Get a cost canvas")
      .annotate(SuccessDescription, "Canvas"),
    HttpApiEndpoint.put("update", "/:id", {
      params: OrgIdParams,
      payload: CostCanvasInput,
      success: CostCanvas,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Replace a cost canvas")
      .annotate(SuccessDescription, "Updated"),
    HttpApiEndpoint.delete("delete", "/:id", {
      params: OrgIdParams,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Delete a cost canvas")
      .annotate(
        OpenApi.Description,
        "Soft delete. Its dashboard cards and delivery schedules go with it.",
      )
      .annotate(SuccessDescription, "Deleted"),
    HttpApiEndpoint.post("run", "/:id/run", {
      params: OrgIdParams,
      payload: RunBody,
      success: CostCanvasRunResult,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Run (refresh) a cost canvas")
      .annotate(
        OpenApi.Description,
        "Re-executes every block's query. Deterministic; no model call.",
      )
      .annotate(OpenApi.Transform, optionalRequestBody)
      .annotate(SuccessDescription, "Result"),
    // `chat:write` as well, checked in the handler.
    HttpApiEndpoint.post("conversation", "/:id/conversation", {
      params: OrgIdParams,
      payload: ConversationBody,
      success: CanvasConversation,
      error: [BadRequest, Forbidden, NotFound],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Open the caller's editing conversation for a canvas")
      .annotate(OpenApi.Transform, optionalRequestBody)
      .annotate(SuccessDescription, "Conversation"),
    HttpApiEndpoint.get("pdf", "/:id/pdf", {
      params: OrgIdParams,
      query: TzQuery,
      success: PdfDocument,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Export a cost canvas as a PDF")
      .annotate(SuccessDescription, "The PDF, as an attachment"),
    HttpApiEndpoint.get("listNotifications", "/:id/notifications", {
      params: OrgIdParams,
      success: Schema.Array(CostCanvasNotification),
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "List a canvas's delivery schedules")
      .annotate(SuccessDescription, "Schedules"),
    HttpApiEndpoint.get("notificationTargets", "/:id/notifications/targets", {
      params: OrgIdParams,
      success: ReportDeliveryTargets,
      error: NotFound,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "List the destinations a canvas schedule can deliver to")
      .annotate(SuccessDescription, "Targets"),
    HttpApiEndpoint.post("createNotification", "/:id/notifications", {
      params: OrgIdParams,
      payload: DashboardNotificationInput,
      success: CostCanvasNotification,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Create a canvas delivery schedule")
      .annotate(SuccessDescription, "Created"),
    HttpApiEndpoint.put("updateNotification", "/:id/notifications/:notificationId", {
      params: ScheduleParams,
      payload: DashboardNotificationInput,
      success: CostCanvasNotification,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Replace a canvas delivery schedule")
      .annotate(SuccessDescription, "Updated"),
    HttpApiEndpoint.delete("deleteNotification", "/:id/notifications/:notificationId", {
      params: ScheduleParams,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Delete a canvas delivery schedule")
      .annotate(SuccessDescription, "Deleted"),
    HttpApiEndpoint.post("sendNotification", "/:id/notifications/:notificationId/send", {
      params: ScheduleParams,
      success: DashboardNotificationSendResult,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Send a canvas delivery now")
      .annotate(SuccessDescription, "Outcome"),
  )
  .prefix("/api/org/:orgId/cost-canvases")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Cost canvases") {}

export class CostCanvasesApi extends withApiDefaults(
  HttpApi.make("cost-canvases").add(CostCanvasesGroup),
) {}
