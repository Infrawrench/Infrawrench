/**
 * Dashboards: `/api/org/:orgId/dashboards`, the endpoint definitions.
 *
 * Definitions only (schemas in `./schemas.ts`, the groups and the `HttpApi`
 * here): no handlers and no server code, so a client can be derived from
 * this file. One Hono router used to serve all of it; the endpoints are
 * grouped here by what they act on, under the one `Dashboards` tag:
 *
 * - `dashboards`: the dashboards themselves, their card order, and the
 *   restored-tab check.
 * - `dashboardDefaults`: which dashboard a caller lands on (user, then role,
 *   then org).
 * - `dashboardWidgets`: non-resource cards (cost graphs, reports, budgets,
 *   KPIs, text) and the KPI evaluator.
 * - `dashboardPins`: resource and workflow pins and their cached probe data.
 *
 * Reads are `dashboards:read`, writes `dashboards:write`, and every write
 * also needs `editor` on the dashboard through object sharing (checked by the
 * handlers). `/dashboards/:id/pdf` and `/:id/notifications…` share this prefix
 * and live in the `dashboard-notifications` domain.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { DashboardKpiRequest } from "../../schemas";
import { RequiredPermission, SuccessDescription } from "../../http/annotations";
import { withApiDefaults } from "../../http/api-defaults";
import { BadRequest, Forbidden, NotFound } from "../../http/errors";
import { OrgAuth } from "../../http/middleware-tags";
import { Ok, OrgId, OrgIdParams, OrgParams, Uuid } from "../../http/schemas/common";
import { describeResponse, documentedAs } from "../../http/schemas/documented";
import {
  CreateWidgetRequest,
  Dashboard,
  DashboardFull,
  DashboardKpiResult,
  DashboardNameRequest,
  DashboardWidgetFull,
  DashboardWithPins,
  DefaultDashboardResolution,
  PinFull,
  PinRangeResponse,
  PinRequest,
  ProbeRequest,
  ProbeStatus,
  ReorderRequest,
  RoleDefaultDashboard,
  SetDefaultDashboardRequest,
  UnpinRequest,
  UpdateWidgetRequest,
  ValidateTabsRequest,
  ValidateTabsResponse,
  WorkflowPinRequest,
} from "./schemas";

const message = Schema.String.annotate({ description: "Human-readable error message" });

/** A role default the role could not use: it lacks `dashboards:read`, or the dashboard is not shared with it. */
export class DashboardUnprocessable extends Schema.Error<DashboardUnprocessable>(
  "infrawrench/http/dashboards/Unprocessable",
)({ error: message }, { httpApiStatus: 422, identifier: "Error" }) {}

/**
 * The 422's description as the hand-written spec had it: the spec builder only
 * names the statuses every domain shares.
 */
const unprocessableDescription = describeResponse(422, "Bad request");

const PREFIX = "/api/org/:orgId/dashboards";
const RoleParams = { orgId: OrgId, roleId: Uuid } as const;
const WidgetParams = { orgId: OrgId, widgetId: Uuid } as const;
const PinParams = { orgId: OrgId, pinId: Uuid } as const;

export class DashboardsGroup extends HttpApiGroup.make("dashboards")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: Schema.Array(Dashboard),
    })
      .annotate(RequiredPermission, "dashboards:read")
      .annotate(OpenApi.Summary, "List dashboards")
      .annotate(SuccessDescription, "Dashboards"),
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: DashboardNameRequest,
      success: DashboardFull,
    })
      .annotate(RequiredPermission, "dashboards:write")
      .annotate(OpenApi.Summary, "Create a dashboard")
      .annotate(SuccessDescription, "Created"),
    HttpApiEndpoint.get("get", "/:id", {
      params: OrgIdParams,
      success: DashboardWithPins,
      error: NotFound,
    })
      .annotate(RequiredPermission, "dashboards:read")
      .annotate(OpenApi.Summary, "Get a dashboard with its pins")
      .annotate(SuccessDescription, "Dashboard"),
    HttpApiEndpoint.post("rename", "/:id/rename", {
      params: OrgIdParams,
      payload: DashboardNameRequest,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "dashboards:write")
      .annotate(OpenApi.Summary, "Rename a dashboard")
      .annotate(SuccessDescription, "Renamed"),
    HttpApiEndpoint.delete("delete", "/:id", {
      params: OrgIdParams,
      success: Ok,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "dashboards:write")
      .annotate(OpenApi.Summary, "Delete a dashboard")
      .annotate(OpenApi.Description, "Cannot delete the default dashboard.")
      .annotate(SuccessDescription, "Deleted"),
    HttpApiEndpoint.post("reorder", "/:id/reorder", {
      params: OrgIdParams,
      payload: ReorderRequest,
      success: Ok,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "dashboards:write")
      .annotate(OpenApi.Summary, "Reorder dashboard cards")
      .annotate(
        OpenApi.Description,
        "Persists the order of a dashboard's grid. Pass `cards` to order resource pins, " +
          "workflow pins, and widgets as one sequence; `resourceIds` orders resource pins alone.",
      )
      .annotate(SuccessDescription, "Reordered"),
    HttpApiEndpoint.post("validateTabs", "/validate-tabs", {
      params: OrgParams,
      payload: ValidateTabsRequest,
      success: ValidateTabsResponse,
    })
      .annotate(RequiredPermission, "dashboards:read")
      .annotate(OpenApi.Summary, "Validate workspace tab targets still exist")
      .annotate(SuccessDescription, "Result"),
  )
  .prefix(PREFIX)
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Dashboards") {}

export class DashboardDefaultsGroup extends HttpApiGroup.make("dashboardDefaults")
  .add(
    HttpApiEndpoint.get("resolve", "/default", {
      params: OrgParams,
      success: DefaultDashboardResolution,
    })
      .annotate(RequiredPermission, "dashboards:read")
      .annotate(OpenApi.Summary, "Which dashboard the caller lands on, and why")
      .annotate(
        OpenApi.Description,
        "Resolves the caller's default dashboard: their own default, else the default set for " +
          "their role, else the organization default (created as `Home` on first read). A layer " +
          "whose dashboard is no longer shared with the caller is skipped and listed in `skipped`.",
      )
      .annotate(SuccessDescription, "Resolution"),
    HttpApiEndpoint.get("full", "/default/full", {
      params: OrgParams,
      success: DashboardWithPins,
      error: NotFound,
    })
      .annotate(RequiredPermission, "dashboards:read")
      .annotate(OpenApi.Summary, "Get the caller's default dashboard with its pins")
      .annotate(
        OpenApi.Description,
        "The dashboard `GET /dashboards/default` resolves to, with its cards. The organization " +
          "default is created as `Home` on first read.",
      )
      .annotate(SuccessDescription, "Default dashboard"),
    HttpApiEndpoint.put("setMine", "/default/me", {
      params: OrgParams,
      payload: SetDefaultDashboardRequest,
      success: DefaultDashboardResolution,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "dashboards:read")
      .annotate(OpenApi.Summary, "Set my default dashboard")
      .annotate(
        OpenApi.Description,
        "Overrides the role and organization defaults for the caller in this organization. The " +
          "dashboard must be one the caller can open.",
      )
      .annotate(SuccessDescription, "The caller's resolution after the change"),
    HttpApiEndpoint.delete("clearMine", "/default/me", {
      params: OrgParams,
      success: DefaultDashboardResolution,
    })
      .annotate(RequiredPermission, "dashboards:read")
      .annotate(OpenApi.Summary, "Clear my default dashboard")
      .annotate(SuccessDescription, "The caller's resolution after the change"),
    HttpApiEndpoint.get("roleDefaults", "/role-defaults", {
      params: OrgParams,
      success: Schema.Array(RoleDefaultDashboard),
    })
      .annotate(RequiredPermission, "team:read")
      .annotate(OpenApi.Summary, "List each role's default dashboard")
      .annotate(SuccessDescription, "Every role, system and custom, with its default"),
    // Gated on `org:settings:write`, not `team:role:write`, and deliberately
    // outside `/team`: choosing where a role lands grants nobody anything (the
    // dashboard must already be visible to the role), so it is org
    // configuration an API key may manage, unlike defining a role (see
    // `auth/api-key-route-policy.ts`).
    HttpApiEndpoint.put("setRole", "/role-defaults/:roleId", {
      params: RoleParams,
      payload: SetDefaultDashboardRequest,
      success: RoleDefaultDashboard,
      error: [BadRequest, NotFound, DashboardUnprocessable],
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Set a role's default dashboard")
      .annotate(
        OpenApi.Description,
        "Members holding the role land on this dashboard unless they picked their own. Refused " +
          "with 422 when the role lacks `dashboards:read` or the dashboard is not shared with the " +
          "role (org-wide or by a role grant). Works for system and custom roles. Needs `org:settings:write` (not `team:role:write`), so an API key can manage it.",
      )
      .annotate(SuccessDescription, "The role's default")
      .annotate(OpenApi.Transform, unprocessableDescription),
    HttpApiEndpoint.delete("clearRole", "/role-defaults/:roleId", {
      params: RoleParams,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Clear a role's default dashboard")
      .annotate(SuccessDescription, "Cleared"),
  )
  .prefix(PREFIX)
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Dashboards") {}

export class DashboardWidgetsGroup extends HttpApiGroup.make("dashboardWidgets")
  .add(
    HttpApiEndpoint.post("create", "/widgets", {
      params: OrgParams,
      payload: CreateWidgetRequest,
      success: DashboardWidgetFull,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "dashboards:write")
      .annotate(
        OpenApi.Summary,
        "Add a widget (cost graph, report, budget, KPI, text, ...) to a dashboard",
      )
      .annotate(SuccessDescription, "Created"),
    HttpApiEndpoint.patch("update", "/widgets/:widgetId", {
      params: WidgetParams,
      payload: UpdateWidgetRequest,
      success: DashboardWidgetFull,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "dashboards:write")
      .annotate(OpenApi.Summary, "Update a widget's title, config, or layout")
      .annotate(SuccessDescription, "Updated"),
    HttpApiEndpoint.post("duplicate", "/widgets/:widgetId/duplicate", {
      params: WidgetParams,
      success: DashboardWidgetFull,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "dashboards:write")
      .annotate(OpenApi.Summary, "Copy a widget in place")
      .annotate(
        OpenApi.Description,
        "Inserts a copy with the same kind, config and size directly after the original, moving " +
          "every card behind it one slot along. A copy of a budget or report card is a second view " +
          "onto the same budget or report. Audit-logged.",
      )
      .annotate(SuccessDescription, "The copy"),
    HttpApiEndpoint.delete("delete", "/widgets/:widgetId", {
      params: WidgetParams,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "dashboards:write")
      .annotate(OpenApi.Summary, "Remove a widget from a dashboard")
      .annotate(SuccessDescription, "Deleted"),
    // `dashboards:read` is the gate; `costs:read` always and `budgets:read`
    // for a budget source are checked in the handler, as the route did.
    HttpApiEndpoint.post("kpi", "/kpi", {
      params: OrgParams,
      payload: DashboardKpiRequest,
      success: DashboardKpiResult,
      error: [BadRequest, Forbidden, NotFound],
    })
      .annotate(RequiredPermission, "dashboards:read")
      .annotate(OpenApi.Summary, "Evaluate a KPI widget config")
      .annotate(
        OpenApi.Description,
        "Answers one KPI config: a saved card posts its own, an editor posts one to preview it. " +
          "Needs `costs:read`, plus `budgets:read` for a budget source; figures are measured inside " +
          "the caller's cost visibility scope.",
      )
      .annotate(SuccessDescription, "The figure and its comparison"),
  )
  .prefix(PREFIX)
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Dashboards") {}

export class DashboardPinsGroup extends HttpApiGroup.make("dashboardPins")
  .add(
    HttpApiEndpoint.post("pin", "/pin", {
      params: OrgParams,
      payload: PinRequest,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "dashboards:write")
      .annotate(OpenApi.Summary, "Pin a resource to a dashboard")
      .annotate(SuccessDescription, "Pinned"),
    HttpApiEndpoint.post("unpin", "/unpin", {
      params: OrgParams,
      payload: UnpinRequest,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "dashboards:write")
      .annotate(OpenApi.Summary, "Unpin a resource")
      .annotate(SuccessDescription, "Unpinned"),
    HttpApiEndpoint.post("pinWorkflow", "/workflow-pin", {
      params: OrgParams,
      payload: WorkflowPinRequest,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "dashboards:write")
      .annotate(OpenApi.Summary, "Pin a workflow's metrics to a dashboard")
      .annotate(SuccessDescription, "Pinned"),
    HttpApiEndpoint.post("unpinWorkflow", "/workflow-unpin", {
      params: OrgParams,
      payload: WorkflowPinRequest,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "dashboards:write")
      .annotate(OpenApi.Summary, "Unpin a workflow from a dashboard")
      .annotate(SuccessDescription, "Unpinned"),
    HttpApiEndpoint.get("pinFull", "/pin/:pinId", {
      params: PinParams,
      success: PinFull,
      error: NotFound,
    })
      .annotate(RequiredPermission, "dashboards:read")
      .annotate(OpenApi.Summary, "Full enriched pin data + cached probe status")
      .annotate(SuccessDescription, "Pin"),
    // Read raw and parsed with `Number(...)`, as the route always did: a
    // missing or non-numeric bound is its own `Invalid fromMs/toMs` 400.
    HttpApiEndpoint.get("pinRange", "/pin/:pinId/range", {
      params: PinParams,
      query: {
        fromMs: Schema.optionalKey(documentedAs(Schema.Int)),
        toMs: Schema.optionalKey(documentedAs(Schema.Int)),
      },
      success: PinRangeResponse,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "dashboards:read")
      .annotate(OpenApi.Summary, "Historical metric series for a pinned resource")
      .annotate(
        OpenApi.Description,
        "Returns per-series metric points between fromMs and toMs. The backend auto-routes " +
          "between raw, 1-minute, and 1-hour rollups based on span: ≤2h raw, ≤7d 1m, >7d 1h.",
      )
      .annotate(SuccessDescription, "Series"),
    HttpApiEndpoint.post("probe", "/probe", {
      params: OrgParams,
      payload: ProbeRequest,
      success: Schema.Record(Schema.String, ProbeStatus),
    })
      .annotate(RequiredPermission, "dashboards:read")
      .annotate(OpenApi.Summary, "Read cached stats/metrics for dashboard cards")
      .annotate(SuccessDescription, "Probe statuses keyed by resource id"),
  )
  .prefix(PREFIX)
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Dashboards") {}

export class DashboardsApi extends withApiDefaults(
  HttpApi.make("dashboards")
    .add(DashboardsGroup)
    .add(DashboardDefaultsGroup)
    .add(DashboardWidgetsGroup)
    .add(DashboardPinsGroup),
) {}
