/**
 * Cost canvases, `/api/org/:orgId/cost-canvases`, the handlers. The logic is
 * in `services/cost-canvases.ts`, shared with the MCP and chat tools; the
 * delivery schedules in `server-core/src/report-delivery/canvas.ts`, which
 * "Send now" hands this process's renderer. Per-object sharing
 * (`cost_canvas`) narrows all of it inside the services.
 */
import { Effect, Predicate, Schema } from "effect";
import type { HttpServerRequest } from "effect/http";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder, HttpApiError } from "effect/http-api";
import { pdfFileName, type CostCanvasNotificationInput } from "@infrawrench/client-core";
import {
  CostCanvasDraftInput,
  CostCanvasInput,
  CostCanvasSpec,
  formatCostCanvasSpecSchemaIssues,
  STRICT_PARSE_OPTIONS,
} from "@infrawrench/ui/schemas";
import {
  ReportNotificationInputError,
  listReportDeliveryTargets,
} from "@infrawrench/server-core/report-delivery/store";
import {
  createCanvasNotification,
  deleteCanvasNotification,
  listCanvasNotifications,
  requireLiveCanvas,
  sendCanvasNotificationNow,
  updateCanvasNotification,
} from "@infrawrench/server-core/report-delivery/canvas";
import {
  CostCanvasInputError,
  createCostCanvas,
  draftCostCanvas,
  ensureCanvasConversation,
  getCostCanvas,
  listCostCanvases,
  runCostCanvas,
  runCostCanvasSpec,
  softDeleteCostCanvas,
  updateCostCanvas,
} from "../../../services/cost-canvases";
import { renderCanvasForDelivery, renderCostCanvasPdf } from "../../../services/cost-canvas-pdf";
import { attachmentDisposition } from "../../../lib/content-disposition";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { BadRequest, badRequest, NotFound, notFound } from "../../errors";
import { readJsonOr } from "../../request-body";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { OrgPrincipal, requirePermission } from "../../principal";
import { respond } from "../../response";
import { ok } from "../../schemas/common";
import {
  DashboardNotificationSendResult,
  ReportDeliveryTargets,
} from "../../schemas/report-delivery";
import { readScheduleBody } from "../cost-report-notifications/delivery";
import {
  CanvasConversation,
  CostCanvas,
  CostCanvasesApi,
  CostCanvasNotification,
  CostCanvasRunResult,
} from "./api";

/** The services' refusals, with the status each carries. */
const canvasRefusal = (error: unknown): BadRequest | NotFound | undefined => {
  if (error instanceof ReportNotificationInputError || error instanceof CostCanvasInputError) {
    return error.status === 404
      ? new NotFound({ error: error.message })
      : new BadRequest({ error: error.message });
  }
  return undefined;
};

/** Promise code whose input errors are the caller's 400 or 404. */
const canvasCall = <A>(fn: () => PromiseLike<A>) => legacyTry(fn, canvasRefusal);

/** A model-authored body, decoded strictly, every issue reported. */
const strictDecode = <S extends Schema.Decoder<unknown>>(schema: S, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value, { ...STRICT_PARSE_OPTIONS, errors: "all" });

/**
 * A canvas or spec body: a refusal is `Invalid canvas: <every issue>`, one
 * sentence the agent can fix the spec from, as the route always answered.
 */
const decodeCanvasBody = <S extends Schema.Decoder<unknown>>(schema: S, value: unknown) =>
  strictDecode(schema, value).pipe(
    Effect.mapError((error) =>
      badRequest(`Invalid canvas: ${formatCostCanvasSpecSchemaIssues(error.issue)}`),
    ),
  );

/** The body as `await c.req.json().catch(() => null)` read it. */
const bodyOrNull = (request: HttpServerRequest.HttpServerRequest) => readJsonOr(request, null);

/** A validated IANA zone from `?tz=`, for the "generated at" line. */
function requestTimezone(tz: string | undefined): string | undefined {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

/**
 * A chat model id as the route passed it on: a string as sent, nothing for
 * an absent one, and anything else as text, which the service refuses as an
 * unknown model.
 */
const modelOf = (value: unknown): string | undefined =>
  value === undefined || value === null
    ? undefined
    : Predicate.isString(value)
      ? value
      : String(value);

/** 404 unless the caller can see the canvas, before any schedule is touched. */
const requireViewableCanvas = Effect.fnUntraced(function* (canvasId: string) {
  const { organizationId } = yield* OrgPrincipal;
  const canvas = yield* legacy(() => getCostCanvas(organizationId, canvasId, null));
  if (!canvas) return yield* notFound();
});

const CostCanvasesHandlers = HttpApiBuilder.group(CostCanvasesApi, "costCanvases", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const canvases = yield* legacy(() =>
          listCostCanvases(organizationId, session.userId ?? null),
        );
        return yield* respond(Schema.Array(CostCanvas))(canvases);
      }),
    )
    // Create from a full spec; no model involved.
    .handleRaw("create", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const input = yield* decodeCanvasBody(CostCanvasInput, yield* bodyOrNull(request));
        const created = yield* legacy(() =>
          createCostCanvas(organizationId, input, session.userId ?? null),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "cost_canvas.create",
            entityType: "cost_canvas",
            entityId: created.id,
            metadata: { name: created.name },
          }),
        );
        return yield* respond(CostCanvas)(created);
      }),
    )
    // An empty canvas plus a conversation, from a prompt.
    .handleRaw("draft", ({ request }) =>
      Effect.gen(function* () {
        yield* requirePermission("chat:write");
        const { organizationId, session } = yield* OrgPrincipal;
        const userId = session.userId;
        if (!userId) return yield* badRequest("A user is required to start a canvas");
        const input = yield* HttpApiError.HttpApiSchemaError.wrap(
          "Payload",
          strictDecode(CostCanvasDraftInput, yield* bodyOrNull(request)),
        ).pipe(Effect.orDie);
        const created = yield* canvasCall(() => draftCostCanvas(organizationId, input, userId));
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId,
            action: "cost_canvas.create",
            entityType: "cost_canvas",
            entityId: created.id,
            metadata: { name: created.name, draft: true },
          }),
        );
        return yield* respond(CostCanvas)(created);
      }),
    )
    // Run an unsaved spec, for previewing a proposed edit.
    .handleRaw("preview", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, permissions } = yield* OrgPrincipal;
        const body = yield* bodyOrNull(request);
        const fields = Predicate.isObject(body) ? body : {};
        const spec = yield* decodeCanvasBody(CostCanvasSpec, fields["spec"]);
        const name = fields["name"];
        const result = yield* legacy(() =>
          runCostCanvasSpec(
            organizationId,
            { id: null, name: Predicate.isString(name) ? name : "Preview", spec },
            { granted: permissions, includeChartData: fields["includeChartData"] !== false },
          ),
        );
        return yield* respond(CostCanvasRunResult)(result);
      }),
    )
    .handle("get", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const canvas = yield* legacy(() =>
          getCostCanvas(organizationId, params.id, session.userId ?? null),
        );
        if (!canvas) return yield* notFound();
        return yield* respond(CostCanvas)(canvas);
      }),
    )
    // Full replace: the manual editor, and renames.
    .handleRaw("update", ({ params, request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const input = yield* decodeCanvasBody(CostCanvasInput, yield* bodyOrNull(request));
        const updated = yield* legacy(() =>
          updateCostCanvas(organizationId, params.id, input, session.userId ?? null),
        );
        if (!updated) return yield* notFound();
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "cost_canvas.update",
            entityType: "cost_canvas",
            entityId: updated.id,
            metadata: { name: updated.name },
          }),
        );
        return yield* respond(CostCanvas)(updated);
      }),
    )
    // Soft delete, with its cards and schedules.
    .handle("delete", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const deleted = yield* legacy(() => softDeleteCostCanvas(organizationId, params.id));
        if (!deleted) return yield* notFound();
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "cost_canvas.delete",
            entityType: "cost_canvas",
            entityId: params.id,
            metadata: {},
          }),
        );
        return ok;
      }),
    )
    // Re-run every block's query.
    .handleRaw("run", ({ params, request }) =>
      Effect.gen(function* () {
        const { organizationId, permissions } = yield* OrgPrincipal;
        const body = yield* readJsonOr(request, {});
        const includeChartData = !Predicate.isObject(body) || body["includeChartData"] !== false;
        const result = yield* legacy(() =>
          runCostCanvas(organizationId, params.id, { granted: permissions, includeChartData }),
        );
        if (!result) return yield* notFound();
        return yield* respond(CostCanvasRunResult)(result);
      }),
    )
    // The caller's conversation for editing the canvas.
    .handleRaw("conversation", ({ params, request }) =>
      Effect.gen(function* () {
        yield* requirePermission("chat:write");
        const { organizationId, session } = yield* OrgPrincipal;
        const userId = session.userId;
        if (!userId) return yield* badRequest("A user is required");
        const body = yield* readJsonOr(request, {});
        const fields = Predicate.isObject(body) ? body : {};
        const conversationId = yield* canvasCall(() =>
          ensureCanvasConversation(organizationId, params.id, userId, {
            model: modelOf(fields["model"]),
            fresh: fields["fresh"] === true,
          }),
        );
        return yield* respond(CanvasConversation)({ conversationId });
      }),
    )
    .handle("pdf", ({ params, query }) =>
      Effect.gen(function* () {
        const { organizationId, permissions } = yield* OrgPrincipal;
        const rendered = yield* legacy(() =>
          renderCostCanvasPdf(organizationId, params.id, {
            granted: permissions,
            timezone: requestTimezone(query.tz),
          }),
        );
        if (!rendered) return yield* notFound();
        // The web response the route always built, passed through untouched.
        return HttpServerResponse.raw(
          new Response(new Uint8Array(rendered.pdf), {
            status: 200,
            headers: {
              "Content-Type": "application/pdf",
              "Content-Disposition": attachmentDisposition(pdfFileName(rendered.name, "canvas")),
              "Content-Length": String(rendered.pdf.byteLength),
              "Cache-Control": "private, no-store",
            },
          }),
        );
      }),
    )
    /* Delivery schedules. */
    .handle("listNotifications", ({ params }) =>
      Effect.gen(function* () {
        yield* requireViewableCanvas(params.id);
        const { organizationId } = yield* OrgPrincipal;
        const schedules = yield* canvasCall(() =>
          listCanvasNotifications(organizationId, params.id),
        );
        return yield* respond(Schema.Array(CostCanvasNotification))(schedules);
      }),
    )
    .handle("notificationTargets", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        yield* canvasCall(() => requireLiveCanvas(organizationId, params.id));
        const targets = yield* legacy(() => listReportDeliveryTargets(organizationId));
        return yield* respond(ReportDeliveryTargets)(targets);
      }),
    )
    .handleRaw("createNotification", ({ params, request }) =>
      Effect.gen(function* () {
        yield* requireViewableCanvas(params.id);
        const { organizationId, session } = yield* OrgPrincipal;
        const input = yield* readScheduleBody<CostCanvasNotificationInput>(request);
        const created = yield* canvasCall(() =>
          createCanvasNotification(organizationId, params.id, input, session.userId ?? null),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "cost_canvas_notification.create",
            entityType: "cost_canvas_notification",
            entityId: created.id,
            metadata: { canvasId: params.id, cadence: created.cadence },
          }),
        );
        return yield* respond(CostCanvasNotification)(created);
      }),
    )
    .handleRaw("updateNotification", ({ params, request }) =>
      Effect.gen(function* () {
        yield* requireViewableCanvas(params.id);
        const { organizationId, session } = yield* OrgPrincipal;
        const input = yield* readScheduleBody<CostCanvasNotificationInput>(request);
        const updated = yield* canvasCall(() =>
          updateCanvasNotification(organizationId, params.id, params.notificationId, input),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "cost_canvas_notification.update",
            entityType: "cost_canvas_notification",
            entityId: updated.id,
            metadata: { canvasId: params.id },
          }),
        );
        return yield* respond(CostCanvasNotification)(updated);
      }),
    )
    .handle("deleteNotification", ({ params }) =>
      Effect.gen(function* () {
        yield* requireViewableCanvas(params.id);
        const { organizationId, session } = yield* OrgPrincipal;
        yield* canvasCall(() =>
          deleteCanvasNotification(organizationId, params.id, params.notificationId),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "cost_canvas_notification.delete",
            entityType: "cost_canvas_notification",
            entityId: params.notificationId,
            metadata: { canvasId: params.id },
          }),
        );
        return ok;
      }),
    )
    .handle("sendNotification", ({ params }) =>
      Effect.gen(function* () {
        yield* requireViewableCanvas(params.id);
        const { organizationId, session } = yield* OrgPrincipal;
        const result = yield* canvasCall(() =>
          sendCanvasNotificationNow(
            organizationId,
            params.id,
            params.notificationId,
            renderCanvasForDelivery,
          ),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "cost_canvas_notification.send",
            entityType: "cost_canvas_notification",
            entityId: params.notificationId,
            metadata: { canvasId: params.id, succeeded: result.succeeded },
          }),
        );
        return yield* respond(DashboardNotificationSendResult)(result);
      }),
    ),
);

export const costCanvasesDomain = makeDomain(
  "cost-canvases",
  CostCanvasesApi,
  CostCanvasesHandlers,
);
