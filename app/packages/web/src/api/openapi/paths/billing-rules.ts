import { z } from "../zod";
import { strict, ErrorResponses, Ok, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const CHARGE_TYPES = [
  "usage",
  "commitment_covered_usage",
  "commitment_fee",
  "commitment_discount",
  "credit",
  "tax",
  "refund",
  "adjustment",
  "support",
  "other",
] as const;

const BillingRuleMatch = strict({
  tagKey: z.string().min(1).max(128).optional(),
  tagValue: z.string().max(256).optional().openapi({
    description: "Only meaningful with tagKey; alone, tagKey matches rows carrying the key.",
  }),
  accountId: z.string().min(1).optional(),
  pluginId: z.string().min(1).optional(),
  service: z.string().min(1).optional(),
  chargeType: z
    .enum(CHARGE_TYPES)
    .optional()
    .openapi({
      description:
        "Narrow to one kind of charge. A markup that recovers overhead usually should not apply " +
        "to credits, refunds or commitment purchases, and this is how that is expressed.",
    }),
}).openapi("BillingRuleMatch", {
  description:
    "All set fields must match (AND); a rule with no fields matches all spend. The same " +
    "vocabulary allocation rules use, plus chargeType.",
});

const BillingRuleAdjustment = strict({
  kind: z.enum(["percentage", "fixed", "reallocation"]).openapi({
    description:
      "`percentage` multiplies matched spend (every matching percentage rule applies, so two " +
      "10% markups compound to 21%). `fixed` adds a flat amount per period, pro-rated across " +
      "the queried range, and is never multiplied by anything. `reallocation` moves matched " +
      "spend onto another cost centre or account; the first matching reallocation rule wins, " +
      "so a row moves exactly once and the organisation's total is unchanged.",
  }),
  percent: z
    .number()
    .min(-100)
    .max(1000)
    .nullable()
    .default(null)
    .openapi({
      description:
        "`percentage` only. Signed: +15 marks up by 15%, -10 discounts by 10%. Bounded below at " +
        "-100 because a discount larger than the cost would turn spend into income.",
    }),
  amount: z.number().min(-1_000_000_000).max(1_000_000_000).nullable().default(null).openapi({
    description: "`fixed` only, in the major unit of `currency`, per `period`.",
  }),
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/)
    .nullable()
    .default(null),
  period: z
    .enum(["daily", "monthly"])
    .nullable()
    .default(null)
    .openapi({
      description:
        "`fixed` only. A monthly amount is pro-rated across partial months: a range covering ten " +
        "days of a 31-day month contributes 10/31 of it.",
    }),
  targetKind: z
    .enum(["cost_centre", "account"])
    .nullable()
    .default(null)
    .openapi({
      description:
        "Required on `reallocation`, optional on `fixed` (where the flat charge is booked), " +
        "never set on `percentage`.",
    }),
  targetId: z.string().min(1).nullable().default(null),
}).openapi("BillingRuleAdjustment");

const BillingRuleInput = strict({
  name: z.string().min(1).max(120).openapi({ example: "Platform overhead recovery" }),
  description: z.string().max(2000).nullable().default(null),
  enabled: z
    .boolean()
    .default(true)
    .openapi({
      description:
        "Disabled rules are kept and excluded from every query. Switching a markup off for a " +
        "quarter is an edit, not a delete.",
    }),
  priority: z
    .number()
    .int()
    .min(0)
    .max(100_000)
    .openapi({
      description:
        "Lower evaluates first. Percentage rules all apply regardless of order (multiplication " +
        "commutes); reallocation is first-match-wins, so priority decides which one moves a row.",
    }),
  match: BillingRuleMatch,
  adjustment: BillingRuleAdjustment,
}).openapi("BillingRuleInput");

const BillingRule = strict({
  id: Uuid,
  name: z.string(),
  description: z.string().nullable(),
  enabled: z.boolean(),
  priority: z.number().int(),
  match: BillingRuleMatch,
  adjustment: BillingRuleAdjustment,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).openapi("BillingRule");

const CurrencyAmounts = z
  .record(z.string(), z.number())
  .openapi({ description: "Currency code → amount in the currency's major unit." });

/**
 * Registered here rather than inside the cost query's own path file so the one
 * shape that guarantees raw stays visible has a single definition.
 */
export const CostAdjustmentSummary = strict({
  rules: z
    .array(
      strict({
        id: Uuid,
        name: z.string(),
        kind: z.enum(["percentage", "fixed", "reallocation"]),
        summary: z.string().openapi({ example: "+15% on tag team=platform" }),
      }),
    )
    .openapi({ description: "The enabled rules in force for this answer, in evaluation order." }),
  rawTotals: CurrencyAmounts.openapi({
    description:
      "The collected, unadjusted totals for exactly the same rows, summed in the same scan. " +
      "Always present on an adjusted answer — this is the figure that reconciles against an " +
      "invoice. Per-series raw figures are deliberately not offered: after a reallocation the " +
      "series are a different partition of the same money.",
  }),
  fixedTotals: CurrencyAmounts.openapi({
    description:
      "Fixed-amount charges over the period, pro-rated. On a cost query these are reported " +
      "here and **not** folded into `totals`, which stays the sum of the series; the figure an " +
      "organisation reports internally is the adjusted total plus this. On a showback report " +
      "they are additionally booked onto the cost centre the rule names.",
  }),
}).openapi("CostAdjustmentSummary", {
  description:
    "What an adjusted answer did. Present whenever the request asked to be adjusted, even for " +
    "an organisation with no rules — its absence means, and can only mean, that every figure " +
    "in the response is exactly what the providers charged.",
});

export function registerBillingRulePaths(ctx: BuildContext) {
  const { registry } = ctx;
  const idParam = OrgIdParam.extend({
    id: Uuid.openapi({ param: { name: "id", in: "path" } }),
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/billing-rules",
    tags: ["Billing Rules"],
    summary: "List billing rules in evaluation order",
    description:
      "Billing rules are the organisation's own adjustments to collected spend — a markup that " +
      "recovers shared overhead, a discount negotiated outside the provider's pricing, a shared " +
      "cluster reallocated onto the teams that use it.\n\n" +
      "**They are applied at query time and never written into stored cost data.** Collected " +
      "spend stays exactly what the provider reported, so it can still be reconciled against an " +
      "invoice, and editing or deleting a rule restates nothing.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Rules, ascending priority then creation time",
        content: { "application/json": { schema: z.array(BillingRule) } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/billing-rules",
    tags: ["Billing Rules"],
    summary: "Create a billing rule",
    description:
      "Requires `org:settings:write` rather than `costs:write`: a billing rule changes every " +
      "figure the organisation reports about itself, which is a governance act on the scale of " +
      "stating an exchange rate, not the scale of saving a report.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: BillingRuleInput } }, required: true },
    },
    responses: {
      200: { description: "Created", content: { "application/json": { schema: BillingRule } } },
      400: ErrorResponses[400],
      409: ErrorResponses[409],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/billing-rules/{id}",
    tags: ["Billing Rules"],
    summary: "Get a billing rule",
    request: { params: idParam },
    responses: {
      200: { description: "The rule", content: { "application/json": { schema: BillingRule } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/billing-rules/{id}",
    tags: ["Billing Rules"],
    summary: "Update a billing rule",
    description:
      "A full replace, `enabled` included — switching a markup off is an edit of the rule, so " +
      "there is one audited action for “this rule changed” rather than two.",
    request: {
      params: idParam,
      body: { content: { "application/json": { schema: BillingRuleInput } }, required: true },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: BillingRule } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
      409: ErrorResponses[409],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/billing-rules/{id}",
    tags: ["Billing Rules"],
    summary: "Delete a billing rule",
    description:
      "Nothing cascades and nothing is restated: no adjustment was ever written into stored " +
      "cost data, so the next read simply computes without this rule.",
    request: { params: idParam },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
    },
  });
}
