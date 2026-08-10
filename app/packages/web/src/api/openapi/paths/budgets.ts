import { z } from "../zod";
import { strict, ErrorResponses, Ok, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const Month = z
  .string()
  .regex(/^\d{4}-\d{2}$/)
  .openapi({ example: "2026-07" });

const BudgetThreshold = strict({
  type: z.enum(["actual", "forecast"]),
  percent: z.number().int().min(1).max(1000),
}).openapi("BudgetThreshold");

const CostFilterRef = strict({
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
}).openapi("BudgetCostFilter");

const BudgetCostBasis = z
  .enum(["cash", "amortized"])
  .describe(
    "Which number the budget tracks. Defaults to `cash` — what the provider charged, when it " +
      "charged it. An organization holding reservations or savings plans usually wants " +
      "`amortized`: a cash budget is blown the month a commitment is bought and then reads as " +
      "under-spent for the rest of the term it paid for.",
  )
  .openapi("BudgetCostBasis");

const BudgetSavedFilterId = z
  .string()
  .describe(
    "A saved cost filter (see /saved-cost-filters) applied by reference and AND-composed " +
      "with `filters` when the budget is evaluated. Updates are full replaces, so omitting " +
      "it on PUT clears it. A reference that fails to resolve errors the budget's " +
      "evaluation rather than silently measuring all spend.",
  );

const BudgetScenarioModelId = z
  .string()
  .describe(
    "A scenario model (see /cost-scenarios) this budget's **forecast** thresholds are measured " +
      "against. Null — the default, and the value for every budget nobody deliberately opts " +
      "in — keeps them on the bare trend. Opting in is per-budget on purpose: a hypothesis " +
      "somebody typed into a form must not silently change when real people get paged. " +
      "`actual` thresholds are never affected; they measure money already spent. Updates are " +
      "full replaces, so omitting it on PUT clears the opt-in.",
  );

const BudgetUseAdjustedSpend = z
  .boolean()
  .describe(
    "Measure this budget against billing-rule-adjusted spend — the internal figure — instead " +
      "of what the providers charged. False by default, and for every budget nobody opted in. " +
      "The default is a deliberate refusal: a markup is organisation policy and a budget " +
      "threshold pages a real person, so adding one settings row must not be able to move " +
      "every on-call rota at once. Unlike a scenario this affects `actual` thresholds too — an " +
      "opted-in budget is measuring the internal number, and month-to-date internal spend is " +
      "as marked up as the forecast is. The alert body says the figure is adjusted and names " +
      "the collected one. Updates are full replaces, so omitting it on PUT clears the opt-in.",
  );

const BudgetInput = strict({
  name: z.string().min(1).max(120),
  amountCents: z.number().int().positive(),
  currency: z.string().length(3).optional(),
  filters: z.array(CostFilterRef).optional(),
  savedFilterId: BudgetSavedFilterId.optional(),
  scenarioModelId: BudgetScenarioModelId.optional(),
  thresholds: z.array(BudgetThreshold).min(1).max(10),
  costBasis: BudgetCostBasis.optional(),
  useAdjustedSpend: BudgetUseAdjustedSpend.optional(),
}).openapi("BudgetInput");

const BudgetFull = strict({
  id: Uuid,
  organizationId: Uuid,
  name: z.string(),
  amountCents: z.number().int(),
  currency: z.string(),
  filters: z.array(CostFilterRef),
  savedFilterId: BudgetSavedFilterId.nullable(),
  scenarioModelId: BudgetScenarioModelId.nullable(),
  thresholds: z.array(BudgetThreshold),
  costBasis: BudgetCostBasis,
  useAdjustedSpend: BudgetUseAdjustedSpend,
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
  costBasis: BudgetCostBasis.describe(
    "The basis `actualCents` and `forecastCents` were measured on.",
  ),
  savedFilterId: BudgetSavedFilterId.nullable(),
  scenarioModelId: BudgetScenarioModelId.nullable(),
  scenarioModelName: z
    .string()
    .nullable()
    .describe(
      "The opted-into model's name, so a card can say whose assumptions are in the number.",
    ),
  useAdjustedSpend: BudgetUseAdjustedSpend,
  rawActualCents: z
    .number()
    .int()
    .nullable()
    .describe(
      "Month-to-date **collected** spend, non-null only for a budget measuring adjusted spend. " +
        'Null on an unadjusted budget rather than a copy of `actualCents`: "there is no ' +
        'separate collected figure because this one is it" and "the collected figure happens ' +
        'to equal the adjusted one" are different facts, and captioning every budget in the ' +
        "organisation would make the adjusted ones invisible.",
    ),
  month: Month,
  actualCents: z.number().int(),
  forecastCents: z
    .number()
    .int()
    .nullable()
    .describe(
      "The **unadjusted trend** forecast, whether or not a scenario is applied — so both " +
        "numbers are always comparable.",
    ),
  scenarioForecastCents: z
    .number()
    .int()
    .nullable()
    .describe(
      "The scenario-adjusted month forecast, set only for a budget that opted into a model, " +
        "and the number its forecast thresholds are judged against. Null means the thresholds " +
        "used `forecastCents`.",
    ),
  currentMonthEvents: z.array(
    strict({
      id: Uuid,
      thresholdType: z.enum(["actual", "forecast"]),
      thresholdPercent: z.number().int(),
      triggeredAt: IsoDateTime,
    }),
  ),
  /**
   * The dashboards carrying a card for this budget. Empty is normal — a budget
   * evaluates and alerts whether or not any dashboard shows it.
   */
  placements: z.array(
    strict({
      widgetId: Uuid,
      dashboardId: Uuid,
      dashboardName: z.string(),
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
