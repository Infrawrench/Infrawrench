/**
 * A business metric's forecasted values, the planned figures a report's
 * driver forecast reads. The report's own forecast routes are documented by
 * the cost-reports HttpApi domain (`http/domains/cost-reports/`).
 */
import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .openapi({ example: "2026-11-01" });

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
