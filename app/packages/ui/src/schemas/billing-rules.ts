/**
 * Billing rule and managed-account pricing bodies, as Effect schemas.
 *
 * Shape only, deliberately: the cross-field rules (a percentage rule carries
 * no amount, a reallocation names a target, tiers ascend) are
 * `billingRuleInputError` and `managedAccountPricingError` in client-core, so
 * the settings form and the API refuse in identical words.
 */
import { Effect, Schema } from "effect";
import {
  BILLING_RULE_FIXED_PERIODS,
  BILLING_RULE_KINDS,
  BILLING_RULE_LIMITS,
  BILLING_RULE_TARGET_KINDS,
  BILLING_RULE_TIER_MODES,
  BILLING_RULE_TIER_SCOPES,
  COST_CHARGE_TYPES,
  DISCOUNT_TREATMENT_MODES,
  MANAGED_ACCOUNT_PRICING_LIMITS,
  PRICING_EXPRESSION_LIMITS,
  type BillingRuleAdjustment as BillingRuleAdjustmentContract,
  type BillingRuleInput as BillingRuleInputContract,
  type BillingRuleMatch as BillingRuleMatchContract,
  type ManagedAccountPricing as ManagedAccountPricingContract,
  type PricingPreviewRequest as PricingPreviewRequestContract,
} from "@infrawrench/client-core";
import { maxLength, minLength, pattern } from "./checks";
import type { Decodes, Exact } from "./contract";
import { matchTagFields, tagValueRequiresKey } from "./cost-centres";
import { CurrencyCode, NonEmptyString } from "./primitives";

const L = BILLING_RULE_LIMITS;
const between = (minimum: number, maximum: number) => Schema.isBetween({ minimum, maximum });

/** The allocation match vocabulary plus `chargeType`. */
export const BillingRuleMatch = Schema.Struct({
  ...matchTagFields,
  chargeType: Schema.optionalKey(
    Schema.Literals(COST_CHARGE_TYPES).annotate({
      description:
        "Narrow to one kind of charge. A markup that recovers overhead usually should not apply " +
        "to credits, refunds or commitment purchases, and this is how that is expressed.",
    }),
  ),
})
  .check(tagValueRequiresKey)
  .annotate({
    identifier: "BillingRuleMatch",
    description:
      "All set fields must match (AND); a rule with no fields matches all spend. The same " +
      "vocabulary allocation rules use, plus chargeType.",
  });

const Percent = Schema.Finite.check(between(L.minPercent, L.maxPercent));

export const BillingRuleTier = Schema.Struct({
  upTo: Schema.NullOr(
    Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(L.maxFixedAmount)),
  ).annotate({
    description:
      "Exclusive upper bound of monthly spend this tier covers, in the rule's `currency`. " +
      "Null on the last tier, which is open-ended.",
  }),
  percent: Percent.annotate({ description: "Signed: +8 marks up by 8%, -2 discounts by 2%." }),
}).annotate({ identifier: "BillingRuleTier" });

/**
 * Every kind-specific field is nullable and defaults to null, so a PUT
 * round-trip of a rule this client did not create still decodes.
 */
export const BillingRuleAdjustment = Schema.Struct({
  kind: Schema.Literals(BILLING_RULE_KINDS).annotate({
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
  percent: Schema.NullOr(Percent)
    .annotate({
      description:
        "`percentage` only. Signed: +15 marks up by 15%, -10 discounts by 10%. Bounded below at " +
        "-100 because a discount larger than the cost would turn spend into income.",
    })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  amount: Schema.NullOr(Schema.Finite.check(between(-L.maxFixedAmount, L.maxFixedAmount)))
    .annotate({ description: "`fixed` only, in the major unit of `currency`, per `period`." })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  currency: Schema.NullOr(CurrencyCode).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  period: Schema.NullOr(Schema.Literals(BILLING_RULE_FIXED_PERIODS))
    .annotate({
      description:
        "`fixed` only. A monthly amount is pro-rated across partial months: a range covering ten " +
        "days of a 31-day month contributes 10/31 of it.",
    })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  targetKind: Schema.NullOr(Schema.Literals(BILLING_RULE_TARGET_KINDS))
    .annotate({
      description:
        "Required on `reallocation`, optional on `fixed` (where the flat charge is booked), " +
        "never set on `percentage`.",
    })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  targetId: Schema.NullOr(NonEmptyString).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  tiers: Schema.NullOr(Schema.mutable(Schema.Array(BillingRuleTier)).check(maxLength(L.maxTiers)))
    .annotate({
      description:
        "`tiered` only. Ascending, with strictly increasing `upTo`; only the last tier is " +
        "open-ended. Thresholds are in `currency`, which a tiered rule requires.",
    })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  tierMode: Schema.NullOr(Schema.Literals(BILLING_RULE_TIER_MODES))
    .annotate({
      description:
        "`tiered` only. `marginal` charges each slice of the month's spend at its own tier's " +
        "rate; `volume` charges the whole month at the rate of the tier the total falls in.",
    })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  tierScope: Schema.NullOr(Schema.Literals(BILLING_RULE_TIER_SCOPES))
    .annotate({
      description:
        "`tiered` only. Whether volume is the customer's matched spend overall or per service.",
    })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  expression: Schema.NullOr(Schema.String.check(maxLength(PRICING_EXPRESSION_LIMITS.maxLength)))
    .annotate({
      description:
        "`expression` only. A pricing expression giving the line's new cost, e.g. " +
        '`if service == "AmazonEC2" and tag.env == "prod" then cost * 1.1`. Parsed and ' +
        "type-checked on save; a syntax or type error is a 400 naming the character it was " +
        "found at. It is evaluated by a small interpreter over a closed set of fields and " +
        "functions, never handed to a database or a script engine.",
      examples: ['if service == "AmazonEC2" and tag.env == "prod" then cost * 1.1'],
    })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
}).annotate({ identifier: "BillingRuleAdjustment" });

/** Create/update body for a billing rule (POST/PUT /billing-rules). */
export const BillingRuleInput = Schema.Struct({
  name: Schema.String.check(minLength(1), maxLength(L.maxNameLength)).annotate({
    examples: ["Platform overhead recovery"],
  }),
  description: Schema.NullOr(Schema.String.check(maxLength(L.maxDescriptionLength))).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  enabled: Schema.Boolean.annotate({
    description:
      "Disabled rules are kept and excluded from every query. Switching a markup off for a " +
      "quarter is an edit, not a delete.",
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  priority: Schema.Int.check(between(0, 100_000)).annotate({
    description:
      "Lower evaluates first. Percentage rules all apply regardless of order (multiplication " +
      "commutes); reallocation is first-match-wins, so priority decides which one moves a row.",
  }),
  match: BillingRuleMatch,
  adjustment: BillingRuleAdjustment,
  managedAccountIds: Schema.optionalKey(
    Schema.mutable(Schema.Array(NonEmptyString))
      .check(maxLength(L.maxManagedAccounts))
      .annotate({
        description:
          "`tiered` and `expression` only: the managed accounts whose invoices this rule prices. " +
          "Empty or absent means every customer whose billing rules are on.",
      }),
  ),
}).annotate({ identifier: "BillingRuleInput" });

/**
 * Reordering: every rule id in the order they should evaluate. The server
 * rewrites priorities to match, in one transaction.
 */
export const BillingRuleReorder = Schema.Struct({
  ids: Schema.mutable(Schema.Array(NonEmptyString)).check(minLength(1), maxLength(L.maxRules)),
}).annotate({ identifier: "BillingRuleOrder" });

/* ------------------------------------------------------------------ *
 * Managed-account pricing: re-rating and discount treatment.
 * ------------------------------------------------------------------ */

const pricingScopeEntryFields = {
  pluginId: Schema.String.check(minLength(1), maxLength(64)).annotate({ examples: ["aws"] }),
  service: Schema.optionalKey(
    Schema.NullOr(Schema.String.check(maxLength(256))).annotate({
      description: "Absent or null means every service of the provider.",
    }),
  ),
};

export const DiscountTreatment = Schema.Struct({
  mode: Schema.Literals(DISCOUNT_TREATMENT_MODES),
  passThroughPercent: Schema.optionalKey(
    Schema.NullOr(Schema.Finite.check(between(0, 100))).annotate({
      description: "`partial` only: the share the customer receives, strictly between 0 and 100.",
    }),
  ),
}).annotate({ identifier: "DiscountTreatment" });

const UpliftPercent = Schema.Finite.check(
  between(
    MANAGED_ACCOUNT_PRICING_LIMITS.minUpliftPercent,
    MANAGED_ACCOUNT_PRICING_LIMITS.maxUpliftPercent,
  ),
);

/** Shape only; the cross-field rules are `managedAccountPricingError`. */
export const ManagedAccountPricing = Schema.Struct({
  rerate: Schema.Struct({
    enabled: Schema.Boolean,
    scope: Schema.mutable(Schema.Array(Schema.Struct(pricingScopeEntryFields)))
      .check(maxLength(MANAGED_ACCOUNT_PRICING_LIMITS.maxScopeEntries))
      .annotate({ description: "Providers or services to re-rate. Empty means every provider." }),
    fallbackUpliftPercent: UpliftPercent.annotate({
      description:
        "Applied to in-scope usage the provider reports no list price for: such a line is " +
        "billed at collected plus this percentage, and counted as `fallback` in the coverage.",
    }),
    uplifts: Schema.mutable(
      Schema.Array(Schema.Struct({ ...pricingScopeEntryFields, percent: UpliftPercent })),
    )
      .check(maxLength(MANAGED_ACCOUNT_PRICING_LIMITS.maxUplifts))
      .annotate({
        description:
          "Per-provider or per-service overrides of the fallback uplift; the most specific wins.",
      }),
  }).annotate({
    description:
      "Present usage at the provider's public on-demand list price instead of what the " +
      "organisation actually paid. Applies to usage and commitment-covered usage lines only.",
  }),
  discounts: DiscountTreatment.annotateKey({
    description:
      "Provider discounts: `commitment_discount` lines and negative `other`/`adjustment` lines " +
      "(enterprise agreements, private pricing, Savings Plan negation).",
  }),
  credits: DiscountTreatment.annotateKey({ description: "Lines of charge type `credit`." }),
  commitmentBenefits: DiscountTreatment.annotateKey({
    description:
      "The difference between list price and the committed rate on covered usage. Measurable " +
      "only where the provider reports a list price.",
  }),
}).annotate({
  identifier: "ManagedAccountPricing",
  description:
    "How a customer's invoice is priced beyond the billing rules. Applied when an invoice is " +
    "computed; collected spend is never rewritten.",
});

/** `POST /billing-rules/preview`. */
export const PricingPreviewRequest = Schema.Struct({
  rule: Schema.optionalKey(Schema.NullOr(BillingRuleInput)).annotateKey({
    description: "A rule to try. Validated exactly as a create would validate it.",
  }),
  ruleId: Schema.optionalKey(
    Schema.NullOr(NonEmptyString).annotate({
      description:
        "With `rule`, the saved rule it replaces (an edit being previewed). Alone, previews the " +
        "saved rule as it stands. Either way `before` is priced without this rule.",
    }),
  ),
  managedAccountId: Schema.optionalKey(
    Schema.NullOr(NonEmptyString).annotate({
      description:
        "Price this customer's scope with their settings. Absent prices the organisation's whole " +
        "spend as one customer. Naming a customer also needs `invoices:read`.",
    }),
  ),
  pricing: Schema.optionalKey(Schema.NullOr(ManagedAccountPricing)).annotateKey({
    description: "Customer settings to try instead of the saved ones.",
  }),
  month: Schema.optionalKey(
    Schema.NullOr(
      Schema.String.check(pattern(/^\d{4}-(0[1-9]|1[0-2])$/, { message: "expected YYYY-MM" })),
    ).annotate({
      description: "`YYYY-MM`; defaults to last calendar month.",
      examples: ["2026-09"],
    }),
  ),
}).annotate({ identifier: "PricingPreviewRequest" });

/**
 * The contract leaves the adjustment's kind-specific fields (and the rule's
 * `description` and `enabled`) optional, as a client may write them; decoding
 * always fills them with their defaults, so those three only hold one way.
 * The zod twins' `Exact` checks never held either; nothing instantiated them.
 */
export type BillingRuleSchemasMatchContract = [
  Exact<typeof BillingRuleMatch.Type, BillingRuleMatchContract>,
  Decodes<typeof BillingRuleAdjustment.Type, BillingRuleAdjustmentContract>,
  Decodes<typeof BillingRuleInput.Type, BillingRuleInputContract>,
  Exact<typeof ManagedAccountPricing.Type, ManagedAccountPricingContract>,
  Decodes<typeof PricingPreviewRequest.Type, PricingPreviewRequestContract>,
];
[true, true, true, true, true] satisfies BillingRuleSchemasMatchContract;
