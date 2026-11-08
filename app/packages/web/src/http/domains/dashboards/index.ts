/**
 * Dashboards: `/api/org/:orgId/dashboards`, the handlers.
 *
 * The database work is `./store.ts`, query for query what the Hono router
 * did; the default-dashboard and KPI services are called as they were. Every
 * call runs through `legacy`/`refusalCall`, inside the request's scopes, so
 * object sharing sees the caller and the KPI figures are measured inside the
 * caller's cost visibility. Audit rows are fire-and-forget, after the write.
 *
 * Most bodies were read with `c.req.json()` and never validated, so they are
 * served with `handleRaw` and read the same way: a body that is not JSON is
 * still the 500 it was. Where a field of the wrong JSON type used to reach
 * Postgres or throw (a title that is not a string, a tab list that is not a
 * list), the body is decoded against a lenient schema and refused as a
 * payload is (`{ error, issues }`).
 */
import { Effect, Layer, Predicate, Result, Schema, SchemaIssue } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { DashboardKpiRequest, decodeForm } from "@infrawrench/api-contract/schemas";
import {
  badRequest,
  Dashboard,
  DashboardFull,
  DashboardKpiResult,
  DashboardsApi,
  DashboardWidgetFull,
  DashboardWithPins,
  DefaultDashboardResolution,
  forbidden,
  Ok,
  ok,
  PinFull,
  PinRangeResponse,
  ProbeStatus,
  RoleDefaultDashboard,
  DashboardUnprocessable,
  ValidateTabsResponse,
} from "@infrawrench/api-contract";
import { logAudit } from "../../../services/audit";
import { DashboardKpiError, evaluateDashboardKpi } from "../../../services/dashboard-kpi";
import {
  DefaultDashboardError,
  clearMyDefaultDashboard,
  clearRoleDefaultDashboard,
  listRoleDefaultDashboards,
  resolveDefaultDashboard,
  setMyDefaultDashboard,
  setRoleDefaultDashboard,
} from "../../../services/default-dashboards";
import { makeDomain } from "../../domain";
import { decodeAsPayload, fieldsOf, readJson, readJsonOr } from "../../request-body";
import { refuse, refusalCall, type StatusRefusal } from "../../refusals";
import { fireAndForget, legacy } from "../../legacy";
import { OrgPrincipal, requirePermission } from "../../principal";
import { respond } from "../../response";
import {
  DashboardRefusal,
  createDashboard,
  deleteDashboard,
  getDashboardWithPins,
  getDefaultDashboardFull,
  getPinFull,
  getPinRange,
  listDashboards,
  pinResource,
  pinWorkflow,
  probeCards,
  renameDashboard,
  reorderCards,
  unpinResource,
  unpinWorkflow,
} from "./store";
import { validateTabs } from "./tabs";
import { createWidget, deleteWidget, duplicateWidget, updateWidget } from "./widgets";

/** The refusals the store and the services throw, each carrying its status. */
const readRefusal = (error: unknown): StatusRefusal | undefined =>
  error instanceof DashboardRefusal ||
  error instanceof DefaultDashboardError ||
  error instanceof DashboardKpiError
    ? { status: error.status, message: error.message }
    : undefined;

const notFoundOnly = { 404: refuse[404] } as const;
const badRequestOrNotFound = { 400: refuse[400], 404: refuse[404] } as const;

/** Body `{ dashboardId }`, or null when it is missing or not a non-empty string. */
const readDashboardId = (body: unknown): string | null => {
  const id = Predicate.isObject(body) ? body["dashboardId"] : undefined;
  return Predicate.isString(id) && id.length > 0 ? id : null;
};

// Lenient readings of the bodies the routes destructured: only what a field
// of the wrong type would have crashed on, or passed to Postgres, is checked.
const WidgetCreateBody = Schema.Struct({
  dashboardId: Schema.optionalKey(Schema.Unknown),
  kind: Schema.optionalKey(Schema.Unknown),
  title: Schema.optionalKey(Schema.NullOr(Schema.String)),
  config: Schema.optionalKey(Schema.Unknown),
});
const WidgetUpdateBody = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  config: Schema.optionalKey(Schema.Unknown),
  gridX: Schema.optionalKey(Schema.Unknown),
  gridY: Schema.optionalKey(Schema.Unknown),
  gridW: Schema.optionalKey(Schema.Unknown),
  gridH: Schema.optionalKey(Schema.Unknown),
});
const ValidateTabsBody = Schema.Struct({
  tabs: Schema.Array(
    Schema.Struct({ id: Schema.String, target: Schema.Record(Schema.String, Schema.Unknown) }),
  ),
});
const ProbeBody = Schema.Struct({
  items: Schema.Array(Schema.Struct({ resourceId: Schema.String })),
});

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

const DashboardsHandlers = HttpApiBuilder.group(DashboardsApi, "dashboards", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const rows = yield* legacy(() => listDashboards(organizationId, session.userId));
        return yield* respond(Schema.Array(Dashboard))(rows);
      }),
    )
    .handle("create", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const created = yield* legacy(() =>
          createDashboard(organizationId, payload.name, session.userId),
        );
        return yield* respond(DashboardFull)(created);
      }),
    )
    .handle("get", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const full = yield* refusalCall(readRefusal, notFoundOnly, () =>
          getDashboardWithPins(organizationId, params.id),
        );
        return yield* respond(DashboardWithPins)(full);
      }),
    )
    .handle("rename", ({ params, payload }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        yield* refusalCall(readRefusal, notFoundOnly, () =>
          renameDashboard(organizationId, params.id, payload.name),
        );
        return ok;
      }),
    )
    .handle("delete", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        yield* refusalCall(readRefusal, badRequestOrNotFound, () =>
          deleteDashboard(organizationId, params.id),
        );
        return ok;
      }),
    )
    .handleRaw("reorder", ({ params, request }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const body = yield* fieldsOf(yield* readJson(request));
        yield* refusalCall(readRefusal, badRequestOrNotFound, () =>
          reorderCards(organizationId, params.id, body),
        );
        return yield* respond(Ok)(ok);
      }),
    )
    .handleRaw("validateTabs", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const { tabs } = yield* decodeAsPayload(ValidateTabsBody, yield* readJson(request));
        const result = yield* legacy(() => validateTabs(organizationId, session.userId, tabs));
        return yield* respond(ValidateTabsResponse)(result);
      }),
    ),
);

const DefaultsHandlers = HttpApiBuilder.group(DashboardsApi, "dashboardDefaults", (handlers) =>
  handlers
    .handle("resolve", () =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const resolution = yield* legacy(() =>
          resolveDefaultDashboard(organizationId, session.userId),
        );
        return yield* respond(DefaultDashboardResolution)(resolution);
      }),
    )
    .handle("full", () =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const full = yield* refusalCall(readRefusal, notFoundOnly, () =>
          getDefaultDashboardFull(organizationId, session.userId),
        );
        return yield* respond(DashboardWithPins)(full);
      }),
    )
    .handleRaw("setMine", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const userId = session.userId;
        const dashboardId = readDashboardId(yield* readJsonOr(request, null));
        if (!dashboardId) return yield* badRequest("dashboardId is required");
        const dashboard = yield* refusalCall(readRefusal, badRequestOrNotFound, () =>
          setMyDefaultDashboard(organizationId, userId, dashboardId),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId,
            action: "dashboard.default.user.set",
            entityType: "dashboard",
            entityId: dashboard.id,
            metadata: { name: dashboard.name },
          }),
        );
        const resolution = yield* legacy(() => resolveDefaultDashboard(organizationId, userId));
        return yield* respond(DefaultDashboardResolution)(resolution);
      }),
    )
    .handle("clearMine", () =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const userId = session.userId;
        yield* legacy(() => clearMyDefaultDashboard(organizationId, userId));
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId,
            action: "dashboard.default.user.clear",
            entityType: "user",
            entityId: userId,
          }),
        );
        const resolution = yield* legacy(() => resolveDefaultDashboard(organizationId, userId));
        return yield* respond(DefaultDashboardResolution)(resolution);
      }),
    )
    .handle("roleDefaults", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const rows = yield* legacy(() => listRoleDefaultDashboards(organizationId));
        return yield* respond(Schema.Array(RoleDefaultDashboard))(rows);
      }),
    )
    .handleRaw("setRole", ({ params, request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const dashboardId = readDashboardId(yield* readJsonOr(request, null));
        if (!dashboardId) return yield* badRequest("dashboardId is required");
        const { role, dashboard } = yield* refusalCall(
          readRefusal,
          {
            ...badRequestOrNotFound,
            422: (error: string) => new DashboardUnprocessable({ error }),
          },
          () => setRoleDefaultDashboard(organizationId, params.roleId, dashboardId),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "dashboard.default.role.set",
            entityType: "role",
            entityId: role.id,
            metadata: {
              roleName: role.name,
              dashboardId: dashboard.id,
              dashboardName: dashboard.name,
            },
          }),
        );
        return yield* respond(RoleDefaultDashboard)({
          roleId: role.id,
          roleName: role.name,
          isSystem: role.isSystem,
          systemKey: role.systemKey,
          dashboardId: dashboard.id,
        });
      }),
    )
    .handle("clearRole", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const role = yield* refusalCall(readRefusal, notFoundOnly, () =>
          clearRoleDefaultDashboard(organizationId, params.roleId),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "dashboard.default.role.clear",
            entityType: "role",
            entityId: role.id,
            metadata: { roleName: role.name },
          }),
        );
        return ok;
      }),
    ),
);

const WidgetsHandlers = HttpApiBuilder.group(DashboardsApi, "dashboardWidgets", (handlers) =>
  handlers
    .handleRaw("create", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const body = yield* decodeAsPayload(WidgetCreateBody, yield* readJson(request));
        const { created, dashboardId, kind } = yield* refusalCall(
          readRefusal,
          badRequestOrNotFound,
          () => createWidget(organizationId, body),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "dashboard_widget.create",
            entityType: "dashboard_widget",
            entityId: created.id,
            metadata: { dashboardId, kind },
          }),
        );
        return yield* respond(DashboardWidgetFull)(created);
      }),
    )
    .handleRaw("update", ({ params, request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const body = yield* decodeAsPayload(WidgetUpdateBody, yield* readJson(request));
        const { updated, dashboardId, kind } = yield* refusalCall(
          readRefusal,
          badRequestOrNotFound,
          () => updateWidget(organizationId, params.widgetId, body),
        );
        // A resize or move is layout, not a change to what the card shows:
        // only the latter goes in the audit log, or every drag would.
        if (body.title !== undefined || body.config !== undefined) {
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "dashboard_widget.update",
              entityType: "dashboard_widget",
              entityId: params.widgetId,
              metadata: { dashboardId, kind },
            }),
          );
        }
        return yield* respond(DashboardWidgetFull)(updated);
      }),
    )
    .handle("duplicate", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const { created, dashboardId, kind, sourceWidgetId } = yield* refusalCall(
          readRefusal,
          badRequestOrNotFound,
          () => duplicateWidget(organizationId, params.widgetId),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "dashboard_widget.duplicate",
            entityType: "dashboard_widget",
            entityId: created.id,
            metadata: { dashboardId, kind, sourceWidgetId },
          }),
        );
        return yield* respond(DashboardWidgetFull)(created);
      }),
    )
    .handle("delete", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const deleted = yield* refusalCall(readRefusal, notFoundOnly, () =>
          deleteWidget(organizationId, params.widgetId),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "dashboard_widget.delete",
            entityType: "dashboard_widget",
            entityId: deleted.id,
            metadata: { dashboardId: deleted.dashboardId },
          }),
        );
        return ok;
      }),
    )
    // Read-only, so it needs the reads its source needs: `costs:read` always,
    // `budgets:read` for a budget. Takes the config rather than a widget id so
    // the editor can preview a card before it is saved.
    .handleRaw("kpi", ({ request }) =>
      Effect.gen(function* () {
        yield* requirePermission("costs:read");
        const { organizationId, permissions } = yield* OrgPrincipal;
        const body = yield* readJsonOr(request, null);
        const decoded = Schema.decodeUnknownResult(DashboardKpiRequest)(body, { errors: "all" });
        if (Result.isFailure(decoded)) {
          // The first problem as the editors word it, then every issue.
          const first = decodeForm(DashboardKpiRequest, body);
          return HttpServerResponse.jsonUnsafe(
            {
              error: first.success ? "Invalid KPI config" : first.message,
              ...formatIssues(decoded.failure.issue),
            },
            { status: 400 },
          );
        }
        const config = decoded.success.config;
        if (config.source.kind === "budget") yield* requirePermission("budgets:read");
        const result = yield* refusalCall(
          readRefusal,
          { ...badRequestOrNotFound, 403: forbidden },
          () => evaluateDashboardKpi(organizationId, config, { granted: permissions }),
        );
        return yield* respond(DashboardKpiResult)(result);
      }),
    ),
);

const PinsHandlers = HttpApiBuilder.group(DashboardsApi, "dashboardPins", (handlers) =>
  handlers
    .handleRaw("pin", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const body = yield* fieldsOf(yield* readJson(request));
        yield* refusalCall(readRefusal, notFoundOnly, () => pinResource(organizationId, body));
        return yield* respond(Ok)(ok);
      }),
    )
    .handleRaw("unpin", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const body = yield* fieldsOf(yield* readJson(request));
        yield* refusalCall(readRefusal, notFoundOnly, () => unpinResource(organizationId, body));
        return yield* respond(Ok)(ok);
      }),
    )
    .handleRaw("pinWorkflow", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const body = yield* fieldsOf(yield* readJson(request));
        yield* refusalCall(readRefusal, notFoundOnly, () => pinWorkflow(organizationId, body));
        return yield* respond(Ok)(ok);
      }),
    )
    .handleRaw("unpinWorkflow", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const body = yield* fieldsOf(yield* readJson(request));
        yield* refusalCall(readRefusal, notFoundOnly, () => unpinWorkflow(organizationId, body));
        return yield* respond(Ok)(ok);
      }),
    )
    .handle("pinFull", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const pin = yield* refusalCall(readRefusal, notFoundOnly, () =>
          getPinFull(organizationId, params.pinId),
        );
        return yield* respond(PinFull)(pin);
      }),
    )
    .handle("pinRange", ({ params, query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const range = yield* refusalCall(readRefusal, badRequestOrNotFound, () =>
          getPinRange(organizationId, params.pinId, query.fromMs, query.toMs),
        );
        return yield* respond(PinRangeResponse)(range);
      }),
    )
    .handleRaw("probe", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const { items } = yield* decodeAsPayload(ProbeBody, yield* readJson(request));
        const results = yield* legacy(() => probeCards(organizationId, items));
        return yield* respond(Schema.Record(Schema.String, ProbeStatus))(results);
      }),
    ),
);

export const dashboardsDomain = makeDomain(
  "dashboards",
  DashboardsApi,
  Layer.mergeAll(DashboardsHandlers, DefaultsHandlers, WidgetsHandlers, PinsHandlers),
);
