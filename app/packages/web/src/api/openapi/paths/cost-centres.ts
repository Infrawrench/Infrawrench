import { z } from "../zod";
import { strict, ErrorResponses, Ok, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";
// One definition of the raw-vs-adjusted shape, shared with the cost query.
import { CostAdjustmentSummary } from "./billing-rules";

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .openapi({ example: "2026-07-01" });

const CostCentreInput = strict({
  name: z.string().min(1).max(120).openapi({ example: "Platform" }),
  description: z.string().max(2000).optional(),
  parentId: Uuid.nullable()
    .optional()
    .openapi({
      description:
        "Cost centre to nest this one under; null is the top level. On an update, moving a " +
        "centre is this field changing — omitting it leaves the centre where it is. Rejected " +
        "with 400 when the parent is unknown, is the centre itself or one of its own " +
        "descendants, or when the resulting tree would be more than 4 levels deep (measured " +
        "over the whole subtree being moved).",
    }),
}).openapi("CostCentreInput");

const CostCentre = strict({
  id: Uuid,
  name: z.string(),
  description: z.string().nullable(),
  parentId: Uuid.nullable().openapi({
    description:
      "The centre this one sits under; null is a top-level centre. Nesting is a reporting " +
      "structure only — allocation still resolves each cost row to exactly one centre.",
  }),
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
  adjustment: CostAdjustmentSummary.optional().openapi({
    description:
      "Set when `adjusted=true`: the rules in force, the collected totals for the same period, " +
      "and the pro-rated fixed charges. Its absence means every figure above is exactly what " +
      "the providers charged.",
  }),
  centres: z
    .array(
      strict({
        costCentreId: Uuid.nullable().openapi({
          description: 'Null for the synthetic "Unallocated" bucket.',
        }),
        name: z.string(),
        totals: CurrencyAmounts.openapi({
          description:
            "Spend allocated directly to this centre. A cost row is allocated exactly once, so " +
            "summing this across every entry equals the organization's spend for the period.",
        }),
        subtreeTotals: CurrencyAmounts.openapi({
          description:
            "This centre's own spend plus every descendant's. Equal to `totals` for a leaf and " +
            "for every centre in an organization that does not nest. Do not sum this across " +
            "entries — parents already contain their children.",
        }),
        parentId: Uuid.nullable().openapi({
          description: "The centre this one sits under; null for a root and for Unallocated.",
        }),
        depth: z.number().int().openapi({ description: "0 for a root; the indentation level." }),
      }),
    )
    .openapi({
      description:
        "Depth-first: each centre immediately followed by its children, siblings name-sorted, " +
        'with the "Unallocated" bucket last.',
    }),
}).openapi("ShowbackReport");

const RangeQuery = strict({
  from: IsoDate.optional().openapi({ description: "Defaults to 30 days ago." }),
  to: IsoDate.optional().openapi({ description: "Defaults to today." }),
  basis: z
    .enum(["cash", "amortized"])
    .optional()
    .openapi({
      description:
        "Which money to sum. `cash` (the default) is what the provider charged on the day it " +
        "charged it; `amortized` spreads a commitment's up-front fee across the term it buys. " +
        "Providers that report no amortized amount fall back to their cash amount.",
    }),
  adjusted: z
    .enum(["true", "false"])
    .optional()
    .openapi({
      description:
        "Apply the organization's billing rules (see /billing-rules): markups multiply, and a " +
        "reallocation moves a centre's spend onto another centre. Off by default — a chargeback " +
        "report that silently showed marked-up numbers is one the receiving team could not " +
        "reconcile. On, the response carries `adjustment` with the collected totals beside the " +
        "adjusted ones. Fixed-amount rules are booked onto the cost centre they name (or " +
        '"Unallocated" when they name none), pro-rated across the period.',
    }),
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
    summary: "Update or move a cost centre",
    description:
      "Renames, redescribes, and/or moves a centre. Moving is `parentId` changing; omitting " +
      "the field leaves the centre where it is. 400 when the move would cycle or breach the " +
      "depth cap.",
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
    description:
      "The centre's allocation rules are deleted with it, so the spend they claimed falls " +
      'through to the next matching rule or to "Unallocated". Child centres are not deleted: ' +
      "they are re-parented onto the deleted centre's own parent (a root's children become " +
      "roots), so a subtree keeps its shape and no ancestor's subtree total moves unexpectedly.",
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

  const SwapRulesBody = strict({
    aId: Uuid,
    bId: Uuid,
  }).openapi("SwapAllocationRulesBody", {
    description: "Two allocation rule ids in the same org whose priorities should be swapped.",
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/cost-centres/rules/swap",
    tags: ["Cost Centres"],
    summary: "Swap the priorities of two allocation rules",
    description:
      "Atomically swaps priorities so first-match-wins order can be edited without a " +
      "half-applied pair of independent updates.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: SwapRulesBody } }, required: true },
    },
    responses: {
      200: {
        description: "Full rule list after the swap, evaluation order",
        content: { "application/json": { schema: z.array(AllocationRule) } },
      },
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
      "centre appears even with zero spend.\n\n" +
      "Cost centres nest, so the list is a depth-first tree. Each entry carries `totals` (spend " +
      "allocated directly to it) and `subtreeTotals` (its own plus every descendant's) — " +
      '"Engineering, of which Platform" needs both. Rules still evaluate first-match-wins by ' +
      "ascending priority against a flat list, so a row is allocated exactly once even when a " +
      "rule targets a parent and another targets its child; at equal priority the more deeply " +
      "nested centre wins.",
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
