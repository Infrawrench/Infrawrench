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

export const BILLING_RULE_KIND_ENUM = [
  "percentage",
  "fixed",
  "reallocation",
  "tiered",
  "expression",
] as const;

const BillingRuleTier = strict({
  upTo: z
    .number()
    .positive()
    .max(1_000_000_000)
    .nullable()
    .openapi({
      description:
        "Exclusive upper bound of monthly spend this tier covers, in the rule's `currency`. " +
        "Null on the last tier, which is open-ended.",
    }),
  percent: z
    .number()
    .min(-100)
    .max(1000)
    .openapi({ description: "Signed: +8 marks up by 8%, -2 discounts by 2%." }),
}).openapi("BillingRuleTier");

const BillingRuleAdjustment = strict({
  kind: z.enum(BILLING_RULE_KIND_ENUM).openapi({
    description:
      "`percentage` multiplies matched spend (every matching percentage rule applies, so two " +
      "10% markups compound to 21%). `fixed` adds a flat amount per period, pro-rated across " +
      "the queried range, and is never multiplied by anything. `reallocation` moves matched " +
      "spend onto another cost centre or account; the first matching reallocation rule wins, " +
      "so a row moves exactly once and the organisation's total is unchanged.\n\n" +
      "`tiered` and `expression` apply **only when a managed account's invoice is priced**: " +
      "`tiered` marks a customer's matched monthly spend up or down by rate tiers on its " +
      "volume, and `expression` computes each matched line's new cost with a sandboxed pricing " +
      "expression. Neither ever changes the organisation's own graphs, budgets or showback.",
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
  tiers: z
    .array(BillingRuleTier)
    .max(20)
    .nullable()
    .default(null)
    .openapi({
      description:
        "`tiered` only. Ascending, with strictly increasing `upTo`; only the last tier is " +
        "open-ended. Thresholds are in `currency`, which a tiered rule requires.",
    }),
  tierMode: z
    .enum(["marginal", "volume"])
    .nullable()
    .default(null)
    .openapi({
      description:
        "`tiered` only. `marginal` charges each slice of the month's spend at its own tier's " +
        "rate; `volume` charges the whole month at the rate of the tier the total falls in.",
    }),
  tierScope: z.enum(["overall", "per_service"]).nullable().default(null).openapi({
    description:
      "`tiered` only. Whether volume is the customer's matched spend overall or per service.",
  }),
  expression: z
    .string()
    .max(2000)
    .nullable()
    .default(null)
    .openapi({
      description:
        "`expression` only. A pricing expression giving the line's new cost, e.g. " +
        '`if service == "AmazonEC2" and tag.env == "prod" then cost * 1.1`. Parsed and ' +
        "type-checked on save; a syntax or type error is a 400 naming the character it was " +
        "found at. It is evaluated by a small interpreter over a closed set of fields and " +
        "functions, never handed to a database or a script engine.",
      example: 'if service == "AmazonEC2" and tag.env == "prod" then cost * 1.1',
    }),
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
  managedAccountIds: z
    .array(z.string().min(1))
    .max(100)
    .optional()
    .openapi({
      description:
        "`tiered` and `expression` only: the managed accounts whose invoices this rule prices. " +
        "Empty or absent means every customer whose billing rules are on.",
    }),
}).openapi("BillingRuleInput");

const BillingRule = strict({
  id: Uuid,
  name: z.string(),
  description: z.string().nullable(),
  enabled: z.boolean(),
  priority: z.number().int(),
  match: BillingRuleMatch,
  adjustment: BillingRuleAdjustment,
  managedAccountIds: z.array(z.string()),
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
        kind: z.enum(BILLING_RULE_KIND_ENUM),
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

/* ------------------------------------------------------------------ *
 * Managed-account pricing, shared with the invoice schemas.
 * ------------------------------------------------------------------ */

const PricingScopeEntry = strict({
  pluginId: z.string().min(1).max(64).openapi({ example: "aws" }),
  service: z
    .string()
    .max(256)
    .nullish()
    .openapi({ description: "Absent or null means every service of the provider." }),
});

const DiscountTreatment = strict({
  mode: z.enum(["pass_through", "partial", "retain"]),
  passThroughPercent: z.number().min(0).max(100).nullish().openapi({
    description: "`partial` only: the share the customer receives, strictly between 0 and 100.",
  }),
}).openapi("DiscountTreatment");

export const ManagedAccountPricing = strict({
  rerate: strict({
    enabled: z.boolean(),
    scope: z.array(PricingScopeEntry).max(100).openapi({
      description: "Providers or services to re-rate. Empty means every provider.",
    }),
    fallbackUpliftPercent: z
      .number()
      .min(-100)
      .max(1000)
      .openapi({
        description:
          "Applied to in-scope usage the provider reports no list price for: such a line is " +
          "billed at collected plus this percentage, and counted as `fallback` in the coverage.",
      }),
    uplifts: z
      .array(PricingScopeEntry.extend({ percent: z.number().min(-100).max(1000) }))
      .max(100)
      .openapi({
        description:
          "Per-provider or per-service overrides of the fallback uplift; the most specific wins.",
      }),
  }).openapi({
    description:
      "Present usage at the provider's public on-demand list price instead of what the " +
      "organisation actually paid. Applies to usage and commitment-covered usage lines only.",
  }),
  discounts: DiscountTreatment.openapi({
    description:
      "Provider discounts: `commitment_discount` lines and negative `other`/`adjustment` lines " +
      "(enterprise agreements, private pricing, Savings Plan negation).",
  }),
  credits: DiscountTreatment.openapi({ description: "Lines of charge type `credit`." }),
  commitmentBenefits: DiscountTreatment.openapi({
    description:
      "The difference between list price and the committed rate on covered usage. Measurable " +
      "only where the provider reports a list price.",
  }),
}).openapi("ManagedAccountPricing", {
  description:
    "How a customer's invoice is priced beyond the billing rules. Applied when an invoice is " +
    "computed; collected spend is never rewritten.",
});

const CurrencyMap = z.record(z.string(), z.number());

export const PricingEffect = strict({
  key: z.string().openapi({
    description:
      "A billing rule id, or one of `rerate:list`, `rerate:fallback`, `treatment:discounts`, " +
      "`treatment:credits`, `treatment:commitment_benefits`.",
  }),
  ruleId: z.string().nullable(),
  label: z.string(),
  kind: z.enum([
    "rerate_list",
    "rerate_fallback",
    "discounts",
    "credits",
    "commitment_benefits",
    ...BILLING_RULE_KIND_ENUM,
  ]),
  totals: CurrencyMap.openapi({ description: "Currency → what it added or removed." }),
}).openapi("PricingEffect", {
  description: "One rule or setting that moved money, in pipeline order.",
});

export const RerateCoverage = strict({
  byCurrency: z.record(
    z.string(),
    strict({
      listPriced: z.number().openapi({
        description: "Collected spend priced from a provider-reported list price.",
      }),
      listTotal: z.number().openapi({ description: "What that spend lists at." }),
      fallback: z
        .number()
        .openapi({ description: "Collected spend with no list price, priced at the uplift." }),
    }),
  ),
  services: z.array(
    strict({
      pluginId: z.string(),
      service: z.string(),
      currency: z.string(),
      listPriced: z.number(),
      fallback: z.number(),
    }),
  ),
}).openapi("RerateCoverage");

export const PricingExpressionFailure = strict({
  ruleId: z.string(),
  name: z.string(),
  lines: z.number().int(),
  message: z.string(),
}).openapi("PricingExpressionFailure", {
  description:
    "An expression rule that could not price some lines (division by zero, a non-finite " +
    "result). Those lines kept their previous cost rather than becoming zero.",
});

const PricingPreviewRequest = strict({
  rule: BillingRuleInput.nullish().openapi({
    description: "A rule to try. Validated exactly as a create would validate it.",
  }),
  ruleId: Uuid.nullish().openapi({
    description:
      "With `rule`, the saved rule it replaces (an edit being previewed). Alone, previews the " +
      "saved rule as it stands. Either way `before` is priced without this rule.",
  }),
  managedAccountId: Uuid.nullish().openapi({
    description:
      "Price this customer's scope with their settings. Absent prices the organisation's whole " +
      "spend as one customer. Naming a customer also needs `invoices:read`.",
  }),
  pricing: ManagedAccountPricing.nullish().openapi({
    description: "Customer settings to try instead of the saved ones.",
  }),
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .nullish()
    .openapi({ description: "`YYYY-MM`; defaults to last calendar month.", example: "2026-09" }),
}).openapi("PricingPreviewRequest");

const PricingPreviewResult = strict({
  month: z.string(),
  from: z.string(),
  to: z.string(),
  managedAccountId: z.string().nullable(),
  collected: CurrencyMap,
  before: CurrencyMap.openapi({
    description:
      "Priced without the candidate: the saved rules minus `ruleId`, with the saved settings.",
  }),
  after: CurrencyMap.openapi({ description: "Priced with the candidate swapped in." }),
  effects: z.array(PricingEffect),
  coverage: RerateCoverage.nullable(),
  warnings: z.array(z.string()),
  expressionFailures: z.array(PricingExpressionFailure),
  changes: z
    .array(
      strict({
        pluginId: z.string(),
        service: z.string(),
        accountName: z.string(),
        chargeType: z.string(),
        currency: z.string(),
        collected: z.number(),
        before: z.number(),
        after: z.number(),
      }),
    )
    .openapi({ description: "The lines that moved most, largest change first, at most 25." }),
  lineCount: z.number().int(),
}).openapi("PricingPreviewResult");

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
    method: "post",
    path: "/api/org/{orgId}/billing-rules/preview",
    tags: ["Billing Rules"],
    summary: "Preview a rule or customer pricing against a month of spend",
    description:
      "Prices one calendar month (last month by default) twice: with the saved rules and " +
      "settings, and with the candidate rule or customer settings swapped in. Nothing is " +
      "written. Returns both totals, every effect, re-rating coverage, any expression failures " +
      "and the lines that moved most.\n\n" +
      "Requires `costs:read`, and `invoices:read` as well when a customer is named.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: PricingPreviewRequest } }, required: true },
    },
    responses: {
      200: {
        description: "The preview",
        content: { "application/json": { schema: PricingPreviewResult } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/billing-rules/reorder",
    tags: ["Billing Rules"],
    summary: "Reorder billing rules",
    description:
      "Rewrites every rule's priority to match the given order (10, 20, 30…) in one " +
      "transaction and one audit entry. The list must name every rule exactly once.",
    request: {
      params: OrgIdParam,
      body: {
        content: {
          "application/json": {
            schema: strict({ ids: z.array(Uuid).min(1).max(100) }).openapi("BillingRuleOrder"),
          },
        },
        required: true,
      },
    },
    responses: {
      200: {
        description: "The rules in their new order",
        content: { "application/json": { schema: z.array(BillingRule) } },
      },
      400: ErrorResponses[400],
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
