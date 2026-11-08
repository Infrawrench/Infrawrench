import { z } from "../zod";
import { strict, Uuid } from "../common";

/*
 * The billing rules routes are served by the `billing-rules` HttpApi domain
 * (`http/domains/billing-rules/`), which documents its own operations. What
 * stays here is the pricing vocabulary the Zod-documented routes still embed:
 * the adjusted cost query and showback (`CostAdjustmentSummary`) and the
 * managed-account invoices (`ManagedAccountPricing`, the pipeline report).
 * The preview endpoint refers to `PricingEffect`, `RerateCoverage` and
 * `PricingExpressionFailure` by name (`http/schemas/zod-components.ts`); the
 * domain's own `ManagedAccountPricing` (the shared request schema) replaces
 * this one in the document.
 */

export const BILLING_RULE_KIND_ENUM = [
  "percentage",
  "fixed",
  "reallocation",
  "tiered",
  "expression",
] as const;

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
      "Always present on an adjusted answer; this is the figure that reconciles against an " +
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
    "an organisation with no rules; its absence means, and can only mean, that every figure " +
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
