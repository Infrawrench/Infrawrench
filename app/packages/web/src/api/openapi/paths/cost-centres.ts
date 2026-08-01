import { z } from "../zod";
import { strict, ErrorResponses, Ok, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .openapi({ example: "2026-07-01" });

const CostCentreInput = strict({
  name: z.string().min(1).max(120).openapi({ example: "Platform" }),
  description: z.string().max(2000).optional(),
}).openapi("CostCentreInput");

const CostCentre = strict({
  id: Uuid,
  name: z.string(),
  description: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).openapi("CostCentre");

const AllocationRuleMatch = strict({
  tagKey: z.string().min(1).max(128).optional(),
  tagValue: z.string().max(256).optional().openapi({
    description: "Only meaningful with tagKey; alone, tagKey matches rows carrying the key.",
  }),
  accountId: z.string().min(1).optional(),
  pluginId: z.string().min(1).optional(),
  service: z.string().min(1).optional(),
}).openapi("AllocationRuleMatch", {
  description:
    "All set fields must match (AND). A rule with no fields is a catch-all that claims " +
    "everything reaching it.",
});

const AllocationRuleInput = strict({
  costCentreId: Uuid,
  priority: z.number().int().min(0).max(100_000).openapi({
    description: "Lower fires first; the first matching rule wins.",
  }),
  match: AllocationRuleMatch,
}).openapi("AllocationRuleInput");

const AllocationRule = strict({
  id: Uuid,
  costCentreId: Uuid,
  priority: z.number().int(),
  match: AllocationRuleMatch,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).openapi("AllocationRule");

const CurrencyAmounts = z
  .record(z.string(), z.number())
  .openapi({ description: "Currency code → amount in the currency's major unit." });

const ShowbackReport = strict({
  from: IsoDate,
  to: IsoDate,
  currencies: z.array(z.string()),
  centres: z.array(
    strict({
      costCentreId: Uuid.nullable().openapi({
        description: 'Null for the synthetic "Unallocated" bucket.',
      }),
      name: z.string(),
      totals: CurrencyAmounts,
    }),
  ),
}).openapi("ShowbackReport");

const RangeQuery = strict({
  from: IsoDate.optional().openapi({ description: "Defaults to 30 days ago." }),
  to: IsoDate.optional().openapi({ description: "Defaults to today." }),
});

export function registerCostCentrePaths(ctx: BuildContext) {
  const { registry } = ctx;
  const idParam = OrgIdParam.extend({
    id: Uuid.openapi({ param: { name: "id", in: "path" } }),
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/cost-centres",
    tags: ["Cost Centres"],
    summary: "List cost centres",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Cost centres, name-sorted",
        content: { "application/json": { schema: z.array(CostCentre) } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/cost-centres",
    tags: ["Cost Centres"],
    summary: "Create a cost centre",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: CostCentreInput } }, required: true },
    },
    responses: {
      200: { description: "Created", content: { "application/json": { schema: CostCentre } } },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/cost-centres/{id}",
    tags: ["Cost Centres"],
    summary: "Update a cost centre",
    request: {
      params: idParam,
      body: { content: { "application/json": { schema: CostCentreInput } }, required: true },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: CostCentre } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/cost-centres/{id}",
    tags: ["Cost Centres"],
    summary: "Delete a cost centre (its allocation rules go with it)",
    request: { params: idParam },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/cost-centres/rules",
    tags: ["Cost Centres"],
    summary: "List allocation rules in evaluation order",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Rules, ascending priority",
        content: { "application/json": { schema: z.array(AllocationRule) } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/cost-centres/rules",
    tags: ["Cost Centres"],
    summary: "Create an allocation rule",
    description:
      "Maps spend onto a cost centre. Rules evaluate first-match-wins by ascending priority " +
      "against each cost row's tags, account, provider, and service.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: AllocationRuleInput } }, required: true },
    },
    responses: {
      200: { description: "Created", content: { "application/json": { schema: AllocationRule } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/cost-centres/rules/{id}",
    tags: ["Cost Centres"],
    summary: "Update an allocation rule",
    request: {
      params: idParam,
      body: { content: { "application/json": { schema: AllocationRuleInput } }, required: true },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: AllocationRule } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/cost-centres/rules/{id}",
    tags: ["Cost Centres"],
    summary: "Delete an allocation rule",
    request: { params: idParam },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/costs/showback",
    tags: ["Costs"],
    summary: "Spend grouped by cost centre (showback)",
    description:
      "Runs the org's allocation rules over collected spend and sums per cost centre and " +
      'currency. Spend no rule claims comes back as the "Unallocated" bucket; every defined ' +
      "centre appears even with zero spend.",
    request: { params: OrgIdParam, query: RangeQuery },
    responses: {
      200: {
        description: "Showback report",
        content: { "application/json": { schema: ShowbackReport } },
      },
      400: ErrorResponses[400],
    },
  });
}
