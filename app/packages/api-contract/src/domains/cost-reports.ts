/**
 * Cost reports: `/api/org/:orgId/cost-reports`, the endpoint definitions.
 *
 * A report is a named, saved cost graph: the object dashboards reference by
 * id through the `cost_report` widget kind. CRUD, `POST /bulk` for moving or
 * deleting many at once, `POST /:id/run` (the report *is* the query), and the
 * report's named forecasts. Reads are `costs:read` and writes `costs:write`:
 * a report is cost data under a name, not dashboard furniture. Bodies are the
 * shared schemas the report editor validates with (`@infrawrench/api-contract/schemas`).
 *
 * The prefix is shared with other domains (`/:id/notifications…`,
 * `/:id/anomaly-alert…`, `/:id/pdf`); nothing here has a second segment one
 * of them uses.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import {
  CostForecastConfidenceLevel,
  CostForecastInput,
  CostForecastRunRequest,
  CostGraphConfig,
  CostReportBulkRequest,
  CostReportInput,
  CostReportRunOverrides,
  IsoDate as Day,
} from "../schemas";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, Conflict, Forbidden, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { IsoDateTime, Ok, OrgId, OrgIdParams, OrgParams, Uuid } from "../http/schemas/common";
import { optionalRequestBody } from "../http/schemas/documented";
import { CostQueryResponse } from "../http/schemas/cost-query";

const ReportDay = Day.annotate({ examples: ["2026-07-01"] });

const CostReportPlacement = Schema.Struct({
  widgetId: Uuid,
  dashboardId: Uuid,
  dashboardName: Schema.String,
}).annotate({ identifier: "CostReportPlacement" });

export const CostReport = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  config: CostGraphConfig,
  folderId: Schema.NullOr(Schema.String).annotate({
    description:
      "Folder the report is filed under (see /cost-report-folders); null is the top level of the " +
      "Reports list. Moving a report is this same PUT with a different folderId; an id from " +
      "another org is a 400. Deleting a folder never deletes its reports; they fall back to " +
      "the top level.",
  }),
  createdByUserId: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  placements: Schema.Array(CostReportPlacement).annotate({
    description:
      "The dashboards carrying a `cost_report` card for this report. Empty is normal: a report " +
      "exists, and can be run, whether or not any dashboard shows it. Deleting the report " +
      "removes these cards; removing a card leaves the report alone.",
  }),
}).annotate({ identifier: "CostReport" });

export const CostReportRunResult = Schema.Struct({
  reportId: Uuid,
  name: Schema.String,
  from: ReportDay,
  to: ReportDay,
  result: CostQueryResponse,
}).annotate({ identifier: "CostReportRunResult" });

export const CostReportBulkResult = Schema.Struct({
  action: Schema.Literals(["move", "delete"]),
  reports: Schema.Int.annotate({ description: "Reports moved or deleted." }),
  folders: Schema.Int.annotate({ description: "Folders moved or deleted." }),
}).annotate({ identifier: "CostReportBulkResult" });

const CostReportBulkProblem = Schema.Struct({
  kind: Schema.Literals(["report", "folder", "target"]),
  id: Schema.String,
  name: Schema.NullOr(Schema.String).annotate({
    description: "The item's name, or null when it does not exist or is not visible to the caller.",
  }),
  message: Schema.String,
}).annotate({ identifier: "CostReportBulkProblem" });

/**
 * The bulk endpoint's 400, refused before anything was written: every blocking
 * item in `problems`, or the schema's `issues` for a malformed body.
 */
export class CostReportBulkRefused extends Schema.Error<CostReportBulkRefused>(
  "infrawrench/http/costReports/BulkRefused",
)(
  {
    error: Schema.String,
    problems: Schema.optionalKey(
      Schema.Array(CostReportBulkProblem).annotate({
        description: "Every item that blocked the request. Present when the body was well-formed.",
      }),
    ),
    issues: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  },
  {
    httpApiStatus: 400,
    identifier: "CostReportBulkError",
    description: "Refused; nothing was changed",
  },
) {}

const ReportParams = OrgIdParams;
const ForecastParams = { orgId: OrgId, id: Uuid, forecastId: Uuid } as const;

export class CostReportsGroup extends HttpApiGroup.make("costReports")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: Schema.Array(CostReport),
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "List saved cost reports")
      .annotate(SuccessDescription, "Reports"),
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: CostReportInput,
      success: CostReport,
      error: [BadRequest, Forbidden],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Create a cost report")
      .annotate(SuccessDescription, "Created")
      .annotate(InvalidRequestMessage, "Invalid cost report"),
    HttpApiEndpoint.post("bulk", "/bulk", {
      params: OrgParams,
      payload: CostReportBulkRequest,
      success: CostReportBulkResult,
      error: CostReportBulkRefused,
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Move or delete many reports and folders at once")
      .annotate(
        OpenApi.Description,
        "All or nothing. Every item is checked first: it exists, the caller's per-object sharing " +
          "allows the action (editor to move, owner to delete, or editor when nobody owns it), and " +
          "for a move, the folder tree that would result keeps every folder within the three-level " +
          "nesting limit and free of cycles. Any problem is a 400 listing each blocking item, and " +
          "nothing is written. Deleting a report removes its dashboard cards and pauses its " +
          "delivery schedules; deleting a folder drops whatever remains inside it to the top level. " +
          "One audit entry is written per item.",
      )
      .annotate(SuccessDescription, "Applied")
      .annotate(InvalidRequestMessage, "Invalid bulk request"),
    HttpApiEndpoint.get("get", "/:id", {
      params: ReportParams,
      success: CostReport,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Get a cost report")
      .annotate(SuccessDescription, "Report"),
    HttpApiEndpoint.put("update", "/:id", {
      params: ReportParams,
      payload: CostReportInput,
      success: CostReport,
      error: [BadRequest, Forbidden, NotFound],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Update a cost report")
      .annotate(
        OpenApi.Description,
        "Replaces the report's name, description, config and folder. Every dashboard showing the " +
          "report picks up the new config; that is what referencing a report by id buys.",
      )
      .annotate(SuccessDescription, "Updated")
      .annotate(InvalidRequestMessage, "Invalid cost report"),
    HttpApiEndpoint.delete("delete", "/:id", {
      params: ReportParams,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Delete a cost report")
      .annotate(
        OpenApi.Description,
        "Soft delete. Every dashboard card pointing at the report is removed with it; a card whose " +
          "report is gone could only ever render as an unavailable tile.",
      )
      .annotate(SuccessDescription, "Deleted"),
    // A read despite the method: nothing is written. The body is optional and
    // read by the handler, since an empty one is the ordinary case.
    HttpApiEndpoint.post("run", "/:id/run", {
      params: ReportParams,
      payload: CostReportRunOverrides,
      success: CostReportRunResult,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Run a cost report")
      .annotate(
        OpenApi.Description,
        "Executes the report's saved config and returns the series, along with the inclusive " +
          "window a relative preset resolved to. The body is optional: the report *is* the query, " +
          "so a caller never has to reassemble its config to get the numbers. It may carry " +
          "one-off display overrides (`measure`, `usageUnit`, `binning`, `cumulative`, `xAxis`) that apply " +
          "to this run only and are never saved; switching a run to `usage` or `count` drops the " +
          "saved forecast, scenario and billing rules, which only apply to money.",
      )
      .annotate(SuccessDescription, "Result")
      .annotate(InvalidRequestMessage, "Invalid overrides")
      .annotate(OpenApi.Transform, optionalRequestBody),
  )
  .prefix("/api/org/:orgId/cost-reports")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Cost reports") {}

/* Named forecasts on a report: the report's permissions and sharing. */

const ForecastDay = Day.annotate({ examples: ["2026-11-01"] });

export const CostForecast = Schema.Struct({
  id: Uuid,
  reportId: Uuid,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  scenarioModelIds: Schema.Array(Uuid),
  driverMetricId: Schema.NullOr(Schema.String),
  isDefault: Schema.Boolean,
  createdByUserId: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "CostForecast" });

export const CostForecastList = Schema.Struct({ forecasts: Schema.Array(CostForecast) });

const CostForecastPoint = Schema.Struct({
  day: ForecastDay,
  expected: Schema.Finite,
  low: Schema.NullOr(Schema.Finite).annotate({
    description: "Lower bound, clamped at zero; null with no fit.",
  }),
  high: Schema.NullOr(Schema.Finite),
}).annotate({ identifier: "CostForecastPoint" });

const CostForecastTotal = Schema.Struct({
  expected: Schema.Finite,
  low: Schema.NullOr(Schema.Finite).annotate({
    description:
      "Lower bound of the window total. Computed from one fit for the whole window rather than " +
      "by summing daily bounds, which would overstate the uncertainty.",
  }),
  high: Schema.NullOr(Schema.Finite),
}).annotate({ identifier: "CostForecastTotal" });

const CostForecastSeries = Schema.Struct({
  forecastId: Schema.NullOr(Uuid).annotate({
    description: "Null for the automatic (trend) forecast.",
  }),
  name: Schema.String,
  isDefault: Schema.Boolean,
  points: Schema.Array(CostForecastPoint),
  total: CostForecastTotal,
  deltaFromBaseline: Schema.Finite.annotate({
    description: "`total.expected` minus the automatic forecast's, over the same window.",
  }),
  scenarios: Schema.Array(
    Schema.Struct({
      modelId: Uuid,
      modelName: Schema.String,
      totalDelta: Schema.Finite.annotate({
        description: "What this model changed over the returned window.",
      }),
      contributions: Schema.Array(
        Schema.Struct({
          adjustmentId: Schema.String,
          label: Schema.String,
          kind: Schema.Literals(["one_off", "recurring", "rate_change"]),
          amount: Schema.Finite,
        }),
      ).annotate({
        description: "Per adjustment, from the day after the last observed day through `to`.",
      }),
      outOfScope: Schema.Array(Schema.String),
    }),
  ),
  driver: Schema.NullOr(
    Schema.Struct({
      metricId: Schema.String,
      metricName: Schema.String,
      metricUnit: Schema.String,
      unitCost: Schema.NullOr(Schema.Finite),
      metricTotal: Schema.Finite,
      coveredDays: Schema.Int,
      totalDays: Schema.Int,
    }),
  ),
  warnings: Schema.Array(Schema.String),
}).annotate({ identifier: "CostForecastSeries" });

export const CostForecastResult = Schema.Struct({
  reportId: Uuid,
  reportName: Schema.String,
  from: ForecastDay,
  to: ForecastDay,
  lastObservedDay: Schema.NullOr(ForecastDay),
  currency: Schema.NullOr(Schema.String).annotate({
    description: "Currency of every amount: the org's display currency when it has one.",
  }),
  confidenceLevel: CostForecastConfidenceLevel,
  baseline: CostForecastSeries,
  forecast: CostForecastSeries,
  forecasts: Schema.optionalKey(Schema.Array(CostForecastSeries)),
}).annotate({ identifier: "CostForecastResult" });

export class CostForecastsGroup extends HttpApiGroup.make("costForecasts")
  .add(
    HttpApiEndpoint.get("list", "/:id/forecasts", {
      params: ReportParams,
      success: CostForecastList,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "List a report's named forecasts")
      .annotate(SuccessDescription, "Forecasts in list order"),
    HttpApiEndpoint.post("create", "/:id/forecasts", {
      params: ReportParams,
      payload: CostForecastInput,
      success: CostForecast,
      error: [BadRequest, Forbidden, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Add a named forecast to a report")
      .annotate(
        OpenApi.Description,
        "A forecast combines a baseline (the trend, or a driver metric's forecasted values times " +
          "the projected unit cost) with scenario models in priority order. Needs editor access to " +
          "the report.",
      )
      .annotate(SuccessDescription, "Created")
      .annotate(InvalidRequestMessage, "Invalid forecast"),
    HttpApiEndpoint.put("update", "/:id/forecasts/:forecastId", {
      params: ForecastParams,
      payload: CostForecastInput,
      success: CostForecast,
      error: [BadRequest, Forbidden, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Replace a named forecast")
      .annotate(SuccessDescription, "Updated")
      .annotate(InvalidRequestMessage, "Invalid forecast"),
    HttpApiEndpoint.delete("delete", "/:id/forecasts/:forecastId", {
      params: ForecastParams,
      success: Ok,
      error: [Forbidden, NotFound],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Delete a named forecast")
      .annotate(SuccessDescription, "Deleted"),
    // A read despite the method, like `/run`; the body is optional.
    HttpApiEndpoint.post("forecastedCosts", "/:id/forecasted-costs", {
      params: ReportParams,
      payload: CostForecastRunRequest,
      success: CostForecastResult,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Forecasted costs for a report")
      .annotate(
        OpenApi.Description,
        "Projected daily spend for the report's scope (its filters, saved filter, cost basis, " +
          "charge types and billing rules), optionally narrowed to providers or services, with a " +
          "low/expected/high band. Returns the automatic forecast and the requested one (the " +
          "report's default when none is named); `all: true` adds every named forecast. Respects " +
          "the caller's cost visibility scope. A read despite the method.",
      )
      .annotate(SuccessDescription, "Forecast")
      .annotate(InvalidRequestMessage, "Invalid request")
      .annotate(OpenApi.Transform, optionalRequestBody),
  )
  .prefix("/api/org/:orgId/cost-reports")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Cost forecasts") {}

export class CostReportsApi extends withApiDefaults(
  HttpApi.make("cost-reports").add(CostReportsGroup).add(CostForecastsGroup),
) {}
