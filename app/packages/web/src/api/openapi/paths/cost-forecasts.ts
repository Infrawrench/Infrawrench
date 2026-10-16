import { z } from "../zod";
import { strict, ErrorResponses, Ok, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .openapi({ example: "2026-11-01" });

const ConfidenceLevel = z
  .union([z.literal(80), z.literal(90), z.literal(95)])
  .describe(
    "Two-sided level of the band, in percent. The band is the least-squares prediction " +
      "interval: it widens with distance from the data and with how badly a straight line fits " +
      "the last 30 days.",
  )
  .openapi("CostForecastConfidenceLevel");

export const CostForecastInput = strict({
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullable().optional(),
  scenarioModelIds: z
    .array(Uuid)
    .max(10)
    .describe(
      "Scenario models to apply, **in priority order**. Each model is applied to the line the " +
        "previous ones produced, so an org-wide percentage in a later model also scales amounts " +
        "an earlier one added. Deleting a model a forecast names is refused.",
    ),
  driverMetricId: z
    .string()
    .nullable()
    .optional()
    .describe(
      "A business metric whose forecasted values drive the baseline: projected unit cost (the " +
        "report's spend per unit, trended) times the forecasted value. Null keeps the trend.",
    ),
  isDefault: z
    .boolean()
    .optional()
    .describe(
      "Make this the report's default forecast, clearing any other. On update, absent keeps the " +
        "current setting and false makes the report fall back to the automatic forecast.",
    ),
}).openapi("CostForecastInput");

export const CostForecast = strict({
  id: Uuid,
  reportId: Uuid,
  name: z.string(),
  description: z.string().nullable(),
  scenarioModelIds: z.array(Uuid),
  driverMetricId: z.string().nullable(),
  isDefault: z.boolean(),
  createdByUserId: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).openapi("CostForecast");

const CostForecastPoint = strict({
  day: IsoDate,
  expected: z.number(),
  low: z.number().nullable().describe("Lower bound, clamped at zero; null with no fit."),
  high: z.number().nullable(),
}).openapi("CostForecastPoint");

const CostForecastTotal = strict({
  expected: z.number(),
  low: z
    .number()
    .nullable()
    .describe(
      "Lower bound of the window total. Computed from one fit for the whole window rather than " +
        "by summing daily bounds, which would overstate the uncertainty.",
    ),
  high: z.number().nullable(),
}).openapi("CostForecastTotal");

const CostForecastSeries = strict({
  forecastId: Uuid.nullable().describe("Null for the automatic (trend) forecast."),
  name: z.string(),
  isDefault: z.boolean(),
  points: z.array(CostForecastPoint),
  total: CostForecastTotal,
  deltaFromBaseline: z
    .number()
    .describe("`total.expected` minus the automatic forecast's, over the same window."),
  scenarios: z.array(
    strict({
      modelId: Uuid,
      modelName: z.string(),
      totalDelta: z.number().describe("What this model changed over the returned window."),
      contributions: z
        .array(
          strict({
            adjustmentId: z.string(),
            label: z.string(),
            kind: z.enum(["one_off", "recurring", "rate_change"]),
            amount: z.number(),
          }),
        )
        .describe("Per adjustment, from the day after the last observed day through `to`."),
      outOfScope: z.array(z.string()),
    }),
  ),
  driver: strict({
    metricId: z.string(),
    metricName: z.string(),
    metricUnit: z.string(),
    unitCost: z.number().nullable(),
    metricTotal: z.number(),
    coveredDays: z.number().int(),
    totalDays: z.number().int(),
  }).nullable(),
  warnings: z.array(z.string()),
}).openapi("CostForecastSeries");

export const CostForecastRunRequest = strict({
  from: IsoDate.optional().describe(
    "First projected day; defaults to (and is never earlier than) the day after the last day " +
      "with observed spend.",
  ),
  to: IsoDate.optional().describe(
    "Last projected day; defaults to 90 days after the last observed day, at most 366.",
  ),
  forecastId: z
    .string()
    .optional()
    .describe(
      'A forecast id, `"baseline"` for the automatic forecast, or absent for the report\'s ' +
        "default (the automatic forecast when none is set).",
    ),
  providers: z
    .array(z.string())
    .max(50)
    .optional()
    .describe("Narrow to these providers (plugin ids), ANDed with the report's filters."),
  services: z
    .array(z.string())
    .max(100)
    .optional()
    .describe("Narrow to these services, ANDed with the report's filters."),
  confidenceLevel: ConfidenceLevel.optional(),
  all: z.boolean().optional().describe("Also return every named forecast, side by side."),
}).openapi("CostForecastRunRequest");

export const CostForecastResult = strict({
  reportId: Uuid,
  reportName: z.string(),
  from: IsoDate,
  to: IsoDate,
  lastObservedDay: IsoDate.nullable(),
  currency: z
    .string()
    .nullable()
    .describe("Currency of every amount: the org's display currency when it has one."),
  confidenceLevel: ConfidenceLevel,
  baseline: CostForecastSeries,
  forecast: CostForecastSeries,
  forecasts: z.array(CostForecastSeries).optional(),
}).openapi("CostForecastResult");

const BusinessMetricForecastValue = strict({
  day: IsoDate,
  value: z.number(),
  updatedAt: IsoDateTime,
}).openapi("BusinessMetricForecastValue");

const BusinessMetricForecastValuesInput = strict({
  values: z
    .array(strict({ date: IsoDate, value: z.number().nonnegative() }))
    .min(1)
    .max(5000),
}).openapi("BusinessMetricForecastValuesInput");

export function registerCostForecastPaths(ctx: BuildContext) {
  const { registry } = ctx;
  const reportParams = () =>
    OrgIdParam.extend({ id: Uuid.openapi({ param: { name: "id", in: "path" } }) });
  const forecastParams = () =>
    reportParams().extend({
      forecastId: Uuid.openapi({ param: { name: "forecastId", in: "path" } }),
    });
  const metricParams = () =>
    OrgIdParam.extend({
      id: z
        .string()
        .openapi({ param: { name: "id", in: "path" }, description: "Metric id or key" }),
    });
  const rangeQuery = () =>
    strict({
      from: IsoDate.optional().openapi({ param: { name: "from", in: "query" } }),
      to: IsoDate.optional().openapi({ param: { name: "to", in: "query" } }),
    });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/cost-reports/{id}/forecasts",
    tags: ["Cost forecasts"],
    summary: "List a report's named forecasts",
    request: { params: reportParams() },
    responses: {
      200: {
        description: "Forecasts in list order",
        content: { "application/json": { schema: strict({ forecasts: z.array(CostForecast) }) } },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/cost-reports/{id}/forecasts",
    tags: ["Cost forecasts"],
    summary: "Add a named forecast to a report",
    description:
      "A forecast combines a baseline (the trend, or a driver metric's forecasted values times " +
      "the projected unit cost) with scenario models in priority order. Needs editor access to " +
      "the report.",
    request: {
      params: reportParams(),
      body: { content: { "application/json": { schema: CostForecastInput } }, required: true },
    },
    responses: {
      200: { description: "Created", content: { "application/json": { schema: CostForecast } } },
      400: ErrorResponses[400],
      403: ErrorResponses[403],
      404: ErrorResponses[404],
      409: ErrorResponses[409],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/cost-reports/{id}/forecasts/{forecastId}",
    tags: ["Cost forecasts"],
    summary: "Replace a named forecast",
    request: {
      params: forecastParams(),
      body: { content: { "application/json": { schema: CostForecastInput } }, required: true },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: CostForecast } } },
      400: ErrorResponses[400],
      403: ErrorResponses[403],
      404: ErrorResponses[404],
      409: ErrorResponses[409],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/cost-reports/{id}/forecasts/{forecastId}",
    tags: ["Cost forecasts"],
    summary: "Delete a named forecast",
    request: { params: forecastParams() },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: Ok } } },
      403: ErrorResponses[403],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/cost-reports/{id}/forecasted-costs",
    tags: ["Cost forecasts"],
    summary: "Forecasted costs for a report",
    description:
      "Projected daily spend for the report's scope (its filters, saved filter, cost basis, " +
      "charge types and billing rules), optionally narrowed to providers or services, with a " +
      "low/expected/high band. Returns the automatic forecast and the requested one (the " +
      "report's default when none is named); `all: true` adds every named forecast. Respects " +
      "the caller's cost visibility scope. A read despite the method.",
    request: {
      params: reportParams(),
      body: {
        required: false,
        content: { "application/json": { schema: CostForecastRunRequest } },
      },
    },
    responses: {
      200: {
        description: "Forecast",
        content: { "application/json": { schema: CostForecastResult } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/business-metrics/{id}/forecast-values",
    tags: ["Business metrics"],
    summary: "List a metric's forecasted values",
    description:
      "Planned values, kept apart from the reported actuals: no unit cost, threshold or " +
      "coverage figure ever reads them. Day order.",
    request: { params: metricParams(), query: rangeQuery() },
    responses: {
      200: {
        description: "Forecasted values",
        content: {
          "application/json": {
            schema: strict({ values: z.array(BusinessMetricForecastValue) }),
          },
        },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/business-metrics/{id}/forecast-values",
    tags: ["Business metrics"],
    summary: "Write forecasted metric values",
    description: "Re-sending a day restates it. Values must be non-negative.",
    request: {
      params: metricParams(),
      body: {
        content: { "application/json": { schema: BusinessMetricForecastValuesInput } },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Written",
        content: {
          "application/json": { schema: strict({ written: z.number().int() }) },
        },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/business-metrics/{id}/forecast-values",
    tags: ["Business metrics"],
    summary: "Delete forecasted metric values",
    description: "Removes planned days in `[from, to]`; omit both to clear every planned day.",
    request: { params: metricParams(), query: rangeQuery() },
    responses: {
      200: {
        description: "Deleted",
        content: {
          "application/json": { schema: strict({ deleted: z.number().int() }) },
        },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });
}
