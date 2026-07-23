import { z } from "../zod";
import { strict, ErrorResponses, Ok, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .openapi({ example: "2026-07-01" });

const Month = z
  .string()
  .regex(/^\d{4}-\d{2}$/)
  .openapi({ example: "2026-07" });

const BudgetThreshold = strict({
  type: z.enum(["actual", "forecast"]),
  percent: z.number().int().min(1).max(1000),
}).openapi("BudgetThreshold");

const CostFilterRef = strict({
  dimension: z.enum(["provider", "account", "service", "region", "resource", "tag"]),
  op: z.enum(["in", "not_in"]),
  values: z.array(z.string()).min(1),
  tagKey: z.string().optional(),
}).openapi("BudgetCostFilter");

const BudgetInput = strict({
  name: z.string().min(1).max(120),
  amountCents: z.number().int().positive(),
  currency: z.string().length(3).optional(),
  filters: z.array(CostFilterRef).optional(),
  thresholds: z.array(BudgetThreshold).min(1).max(10),
}).openapi("BudgetInput");

const BudgetFull = strict({
  id: Uuid,
  organizationId: Uuid,
  name: z.string(),
  amountCents: z.number().int(),
  currency: z.string(),
  filters: z.array(CostFilterRef),
  thresholds: z.array(BudgetThreshold),
  createdByUserId: z.string().nullable(),
  deletedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).openapi("BudgetFull");

const BudgetAlertEvent = strict({
  id: Uuid,
  month: Month,
  thresholdType: z.enum(["actual", "forecast"]),
  thresholdPercent: z.number().int(),
  actualAmountCents: z.number().int(),
  forecastAmountCents: z.number().int().nullable(),
  triggeredAt: IsoDateTime,
}).openapi("BudgetAlertEvent");

const BudgetWithStatus = strict({
  id: Uuid,
  name: z.string(),
  amountCents: z.number().int(),
  currency: z.string(),
  filters: z.array(CostFilterRef),
  thresholds: z.array(BudgetThreshold),
  month: Month,
  actualCents: z.number().int(),
  forecastCents: z.number().int().nullable(),
  currentMonthEvents: z.array(
    strict({
      id: Uuid,
      thresholdType: z.enum(["actual", "forecast"]),
      thresholdPercent: z.number().int(),
      triggeredAt: IsoDateTime,
    }),
  ),
}).openapi("BudgetWithStatus");

export function registerBudgetPaths(ctx: BuildContext) {
  const { registry } = ctx;
  const params = (extra: Record<string, z.ZodType>) => OrgIdParam.extend(extra);
  const idParam = () => params({ id: Uuid.openapi({ param: { name: "id", in: "path" } }) });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/budgets",
    tags: ["Budgets"],
    summary: "List budgets with current-month actuals and forecasts",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Budgets",
        content: { "application/json": { schema: z.array(BudgetWithStatus) } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/budgets",
    tags: ["Budgets"],
    summary: "Create a budget",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: BudgetInput } }, required: true },
    },
    responses: {
      200: { description: "Created", content: { "application/json": { schema: BudgetFull } } },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/budgets/{id}",
    tags: ["Budgets"],
    summary: "Get a budget with current-month status",
    request: { params: idParam() },
    responses: {
      200: { description: "Budget", content: { "application/json": { schema: BudgetFull } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/budgets/{id}",
    tags: ["Budgets"],
    summary: "Update a budget",
    request: {
      params: idParam(),
      body: { content: { "application/json": { schema: BudgetInput } }, required: true },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: BudgetFull } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/budgets/{id}",
    tags: ["Budgets"],
    summary: "Delete a budget",
    request: { params: idParam() },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/budgets/{id}/events",
    tags: ["Budgets"],
    summary: "Alert event history for a budget",
    request: { params: idParam() },
    responses: {
      200: {
        description: "Events",
        content: { "application/json": { schema: z.array(BudgetAlertEvent) } },
      },
      404: ErrorResponses[404],
    },
  });
}
