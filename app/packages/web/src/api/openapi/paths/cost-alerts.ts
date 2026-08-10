import { z } from "../zod";
import { strict, ErrorResponses, Ok, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .openapi({ example: "2026-08-09" });

const CostAlertFilter = strict({
  dimension: z.enum([
    "provider",
    "account",
    "service",
    "region",
    "resource",
    "tag",
    "charge_type",
    "commitment",
  ]),
  op: z.enum(["in", "not_in"]),
  values: z.array(z.string()).min(1),
  tagKey: z.string().optional(),
}).openapi("CostAlertFilter");

const CostChangeCadence = z
  .enum(["daily", "weekly", "monthly"])
  .describe(
    "Which window is compared to which, in complete UTC days (the accruing current day never " +
      "counts). daily: one complete day vs the same weekday one week earlier. weekly: the last " +
      "7 complete days vs the 7 before them. monthly: month-to-date vs the same number of days " +
      "at the start of the prior month — never MTD vs the full prior month.",
  )
  .openapi("CostChangeCadence");

const CostChangeDirection = z.enum(["increase", "decrease", "both"]).openapi("CostChangeDirection");

const CostAlertGroupBy = z
  .enum([
    "provider",
    "account",
    "service",
    "region",
    "resource",
    "tag",
    "charge_type",
    "commitment",
  ])
  .nullable()
  .describe(
    "Per-group fan-out. Null watches the scope's one total; a dimension watches each group " +
      "against its own prior window, and each offending group fires its own event.",
  );

const CostAlertInput = strict({
  name: z.string().min(1).max(120),
  filters: z.array(CostAlertFilter).optional(),
  groupBy: CostAlertGroupBy.optional(),
  groupByTagKey: z.string().optional().describe("Required when groupBy is tag."),
  cadence: CostChangeCadence,
  thresholdPercent: z
    .number()
    .int()
    .min(1)
    .max(10_000)
    .nullable()
    .optional()
    .describe(
      "Percent of the prior window's spend the change must reach. At least one of the two " +
        "thresholds must be set; when both are, BOTH must hold before the alert fires.",
    ),
  thresholdAmountCents: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe("Cents the change must reach."),
  direction: CostChangeDirection,
  enabled: z.boolean().optional(),
}).openapi("CostAlertInput");

const CostAlert = strict({
  id: Uuid,
  name: z.string(),
  filters: z.array(CostAlertFilter),
  groupBy: CostAlertGroupBy,
  groupByTagKey: z.string().nullable(),
  cadence: CostChangeCadence,
  thresholdPercent: z.number().int().nullable(),
  thresholdAmountCents: z.number().int().nullable(),
  direction: CostChangeDirection,
  enabled: z.boolean(),
  lastEvaluatedAt: IsoDateTime.nullable(),
  lastFiredAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
})
  .describe(
    "A change-based cost alert: fires when spend on its scope moves more than the configured " +
      "threshold versus the prior period. The third alert family alongside budgets (absolute " +
      "monthly total) and anomaly detection (statistical outliers against a learned baseline).",
  )
  .openapi("CostAlert");

const CostAlertEvent = strict({
  id: Uuid,
  alertId: Uuid,
  alertName: z.string(),
  periodKey: z
    .string()
    .describe(
      "The cadence period the firing belongs to — a day, an ISO week (2026-W32) or a month " +
        "(2026-08). One period fires at most once per group and currency.",
    ),
  windowFrom: IsoDate,
  windowTo: IsoDate,
  previousFrom: IsoDate,
  previousTo: IsoDate,
  groupKey: z.string().describe("The offending group; empty when the alert watches one total."),
  currency: z.string(),
  previousAmountCents: z.number().int(),
  currentAmountCents: z.number().int(),
  changePercent: z
    .number()
    .int()
    .nullable()
    .describe(
      "Signed percent change. Null when the prior window had no spend at all (new spend — the " +
        "change is infinite); -100 when the group vanished.",
    ),
  direction: z.enum(["increase", "decrease"]),
  firedAt: IsoDateTime,
  notifiedAt: IsoDateTime.nullable(),
}).openapi("CostAlertEvent");

export function registerCostAlertPaths(ctx: BuildContext) {
  const { registry } = ctx;
  const params = (extra: Record<string, z.ZodType>) => OrgIdParam.extend(extra);
  const idParam = () => params({ id: Uuid.openapi({ param: { name: "id", in: "path" } }) });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/cost-alerts",
    tags: ["Cost alerts"],
    summary: "List change-based cost alerts",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Alerts",
        content: { "application/json": { schema: strict({ alerts: z.array(CostAlert) }) } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/cost-alerts/events",
    tags: ["Cost alerts"],
    summary: "List recently fired cost-alert events",
    description:
      "Newest first. Optionally scoped to one alert with ?alertId=; an unknown alertId is a 404, " +
      "distinct from an alert that simply has no events yet.",
    request: {
      params: OrgIdParam,
      query: strict({
        alertId: Uuid.optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      }),
    },
    responses: {
      200: {
        description: "Events",
        content: { "application/json": { schema: strict({ events: z.array(CostAlertEvent) }) } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/cost-alerts",
    tags: ["Cost alerts"],
    summary: "Create a change-based cost alert",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: CostAlertInput } }, required: true },
    },
    responses: {
      200: { description: "Created", content: { "application/json": { schema: CostAlert } } },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/cost-alerts/{id}",
    tags: ["Cost alerts"],
    summary: "Get a cost alert",
    request: { params: idParam() },
    responses: {
      200: { description: "Alert", content: { "application/json": { schema: CostAlert } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/cost-alerts/{id}",
    tags: ["Cost alerts"],
    summary: "Update a cost alert",
    request: {
      params: idParam(),
      body: { content: { "application/json": { schema: CostAlertInput } }, required: true },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: CostAlert } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/cost-alerts/{id}",
    tags: ["Cost alerts"],
    summary: "Delete a cost alert",
    description: "Soft delete. Fired events disappear from the org-wide event feed with it.",
    request: { params: idParam() },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
    },
  });
}
