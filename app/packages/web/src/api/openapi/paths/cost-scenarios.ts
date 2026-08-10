import { z } from "../zod";
import { strict, ErrorResponses, Ok, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .openapi({ format: "date", example: "2026-09-01" });

const ScenarioScopeTerm = strict({
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
}).openapi("CostScenarioScopeTerm");

const CostScenarioAdjustment = strict({
  id: z.string().describe("Stable within the model; also the key of its per-adjustment total."),
  label: z
    .string()
    .describe("What this adjustment is. Named on the chart whenever the scenario moves a number."),
  kind: z
    .enum(["one_off", "recurring", "rate_change"])
    .describe(
      "`one_off` is a single amount on a single day; `recurring` is an amount every period " +
        "from a date; `rate_change` is ±X% of the trend from a date. The split between an " +
        "amount and a percentage of the trend is what fixes the composition order — see the " +
        "`scenario` field on the cost query response.",
    ),
  startDate: IsoDate,
  endDate: IsoDate.nullable().describe(
    "Inclusive last day, or null for indefinitely. Refused for `one_off`, which is one day.",
  ),
  amountCents: z
    .number()
    .int()
    .nullable()
    .describe(
      "Minor units of the model's currency, for the amount kinds; null for `rate_change`. " +
        "May be negative — turning off an old cluster is as real a known future cost as buying " +
        "a new one.",
    ),
  currency: z
    .string()
    .nullable()
    .describe(
      "Always the model's own currency; a model that held two would sum two kinds of money.",
    ),
  period: z
    .enum(["daily", "monthly"])
    .nullable()
    .describe(
      "How often a `recurring` amount charges. A monthly amount is spread evenly across each " +
        "calendar month it covers rather than landing as a spike on the 1st, so a month the " +
        "scenario only partly covers costs proportionally less.",
    ),
  percent: z
    .number()
    .nullable()
    .describe("Percent change to the trend, for `rate_change`. -20 is a fifth cheaper."),
  scope: z
    .array(ScenarioScopeTerm)
    .describe(
      "Which spend this adjustment describes; empty is the whole organization. For a rate " +
        "change the scope is what the percentage is *of*. For an amount it decides whether the " +
        "adjustment applies to a given chart at all — a GCP commitment does not belong on a " +
        "chart filtered to AWS, and one that is excluded is named in `scenario.outOfScope`.",
    ),
}).openapi("CostScenarioAdjustment");

const CostScenarioModel = strict({
  id: Uuid,
  name: z.string(),
  description: z.string().nullable(),
  currency: z.string().describe("The one currency every amount in this model is denominated in."),
  adjustments: z.array(CostScenarioAdjustment),
  createdByUserId: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).openapi("CostScenarioModel");

const CostScenarioModelInput = strict({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  currency: z
    .string()
    .describe(
      "Three-letter code. Every amount in the model must be in it — a model that mixed two " +
        "would produce a projection that is the sum of two kinds of money, so this is refused " +
        "rather than converted behind the caller's back.",
    )
    .openapi({ example: "USD" }),
  adjustments: z.array(CostScenarioAdjustment).min(1).max(50),
}).openapi("CostScenarioModelInput");

const CostScenarioReferent = strict({
  kind: z.enum(["budget", "cost_report", "cost_graph_widget"]),
  id: Uuid.describe("Budget id, report id, or dashboard-widget id."),
  name: z.string(),
  dashboardId: Uuid.optional().describe("Set for `cost_graph_widget` referents."),
  dashboardName: z.string().optional(),
}).openapi("CostScenarioReferent");

export function registerCostScenarioPaths(ctx: BuildContext) {
  const { registry } = ctx;
  const params = (extra: Record<string, z.ZodType>) => OrgIdParam.extend(extra);
  const idParam = () => params({ id: Uuid.openapi({ param: { name: "id", in: "path" } }) });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/cost-scenarios",
    tags: ["Scenario models"],
    summary: "List scenario models",
    description:
      "Named, reusable sets of adjustments an organization overlays on a cost forecast — the " +
      "**known future cost a trend fit cannot see**. Pass an id as `POST /costs/query`'s " +
      "`scenarioModelId` (alongside `forecast: true`) to get the adjusted projection back " +
      "*beside* the unadjusted one, never instead of it.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Scenario models, alphabetically",
        content: {
          "application/json": { schema: strict({ models: z.array(CostScenarioModel) }) },
        },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/cost-scenarios",
    tags: ["Scenario models"],
    summary: "Create a scenario model",
    description:
      "Names must be unique per organization (case-insensitively) — the name is what a chart " +
      "prints under its scenario line and what the CLI's `--scenario <name>` addresses, so two " +
      "models sharing one would make both meaningless. A model needs at least one adjustment: " +
      "an empty model changes nothing, which is the same as applying no scenario.",
    request: {
      params: OrgIdParam,
      body: {
        content: { "application/json": { schema: CostScenarioModelInput } },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Created",
        content: { "application/json": { schema: CostScenarioModel } },
      },
      400: ErrorResponses[400],
      409: {
        description: "A live scenario model already uses this name.",
        content: { "application/json": { schema: strict({ error: z.string() }) } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/cost-scenarios/{id}",
    tags: ["Scenario models"],
    summary: "Get a scenario model",
    request: { params: idParam() },
    responses: {
      200: {
        description: "Scenario model",
        content: { "application/json": { schema: CostScenarioModel } },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/cost-scenarios/{id}",
    tags: ["Scenario models"],
    summary: "Update a scenario model",
    description:
      "Replaces the whole model. This is the high-leverage write: every chart drawing it, and " +
      "**every budget whose forecast thresholds are measured against it**, uses the new " +
      "numbers on its next evaluation — which for a budget can change which alerts fire. " +
      "`GET /{id}/referents` names what a change will touch.",
    request: {
      params: idParam(),
      body: {
        content: { "application/json": { schema: CostScenarioModelInput } },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Updated",
        content: { "application/json": { schema: CostScenarioModel } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
      409: {
        description: "A live scenario model already uses this name.",
        content: { "application/json": { schema: strict({ error: z.string() }) } },
      },
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/cost-scenarios/{id}",
    tags: ["Scenario models"],
    summary: "Delete a scenario model",
    description:
      "Soft delete — **refused with a 409 while anything references the model**, with the " +
      "referents in the body. For a chart, deleting would silently drop the assumptions from a " +
      "projection somebody is reading; for a budget it would move the forecast thresholds back " +
      "to the bare trend, changing when people get paged. Detaching the referents is a " +
      "deliberate step, never a side effect of deletion.",
    request: { params: idParam() },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
      409: {
        description: "Still referenced — the body lists every referent.",
        content: {
          "application/json": {
            schema: strict({ error: z.string(), referents: z.array(CostScenarioReferent) }),
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/cost-scenarios/{id}/referents",
    tags: ["Scenario models"],
    summary: "List a scenario model's referents",
    description:
      "Every budget, cost report and dashboard cost graph referencing this model — what an " +
      "edit will change, and what a delete would be refused over. Budgets come first: they are " +
      "the referents that page people.",
    request: { params: idParam() },
    responses: {
      200: {
        description: "Referents (empty when nothing references the model)",
        content: {
          "application/json": { schema: strict({ referents: z.array(CostScenarioReferent) }) },
        },
      },
      404: ErrorResponses[404],
    },
  });
}
