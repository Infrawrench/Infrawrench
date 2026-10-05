/**
 * Managed-account pricing: the arithmetic every invoice line is built from.
 *
 * The property under test throughout is the ledger: every amount an invoice
 * adds or removes is attributed to the step or rule that did it, and
 * `collected + Σ effects = adjusted` on every bucket.
 */
import { describe, expect, it } from "vitest";
import {
  billingRuleInputError,
  normalizeBillingRuleInput,
  summarizeBillingRules,
  compileBillingRules,
  type BillingRule,
  type BillingRuleInput,
} from "../billing-rules";
import {
  DEFAULT_MANAGED_ACCOUNT_PRICING,
  PRICING_STEP_KEYS,
  billingRuleAppliesToCustomer,
  managedAccountPricingError,
  managedAccountPricingIsNeutral,
  normalizeManagedAccountPricing,
  priceLines,
  pricingTagKeys,
  tierAdjustmentForVolume,
  type ManagedAccountPricing,
  type PricingLine,
} from "../msp-pricing";

function line(over: Partial<PricingLine> = {}): PricingLine {
  return {
    bucket: "centre-a",
    currency: "USD",
    month: "2026-09",
    accountId: "acc-1",
    accountName: "Production",
    pluginId: "aws",
    service: "AmazonEC2",
    region: "us-east-1",
    chargeType: "usage",
    usage: 10,
    unit: "Hrs",
    tags: {},
    collected: 100,
    listedCollected: 0,
    listAmount: 0,
    ...over,
  };
}

let seq = 0;
function rule(adjustment: BillingRule["adjustment"], over: Partial<BillingRule> = {}): BillingRule {
  seq++;
  return {
    id: over.id ?? `rule-${seq}`,
    name: over.name ?? `Rule ${seq}`,
    description: null,
    enabled: true,
    priority: over.priority ?? seq,
    match: over.match ?? {},
    adjustment,
    managedAccountIds: over.managedAccountIds ?? [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function pricing(over: Partial<ManagedAccountPricing> = {}): ManagedAccountPricing {
  return { ...DEFAULT_MANAGED_ACCOUNT_PRICING, ...over };
}

function reconciles(result: ReturnType<typeof priceLines>): void {
  for (const b of result.buckets) {
    const sum = Object.values(b.effects).reduce((a, v) => a + v, 0);
    expect(Math.abs(sum - b.adjustment)).toBeLessThan(1e-5);
    expect(Math.abs(b.collected + b.adjustment - b.adjusted)).toBeLessThan(1e-9);
  }
}

describe("priceLines: neutral settings", () => {
  it("leaves every bucket at its collected amount", () => {
    const r = priceLines([line(), line({ bucket: "centre-b", collected: 40 })], {
      pricing: DEFAULT_MANAGED_ACCOUNT_PRICING,
      rules: [],
    });
    expect(r.buckets.map((b) => [b.bucket, b.adjusted, b.adjustment])).toEqual([
      ["centre-a", 100, 0],
      ["centre-b", 40, 0],
    ]);
    expect(r.effects).toEqual([]);
    expect(r.coverage).toBeNull();
  });

  it("treats the default settings as neutral", () => {
    expect(managedAccountPricingIsNeutral(DEFAULT_MANAGED_ACCOUNT_PRICING)).toBe(true);
    expect(managedAccountPricingIsNeutral(normalizeManagedAccountPricing(null))).toBe(true);
  });
});

describe("priceLines: re-rating to public pricing", () => {
  const rerate = (over: Partial<ManagedAccountPricing["rerate"]> = {}) =>
    pricing({
      rerate: { enabled: true, scope: [], fallbackUpliftPercent: 10, uplifts: [], ...over },
    });

  it("uses the list price where reported and the uplift elsewhere, and reports coverage", () => {
    const r = priceLines(
      [
        line({ collected: 100, listedCollected: 100, listAmount: 130 }),
        line({ service: "AmazonS3", collected: 50 }),
        line({ chargeType: "tax", collected: 20 }),
      ],
      { pricing: rerate(), rules: [] },
    );
    const [bucket] = r.buckets;
    expect(bucket!.collected).toBe(170);
    expect(bucket!.effects[PRICING_STEP_KEYS.rerateList]).toBe(30);
    expect(bucket!.effects[PRICING_STEP_KEYS.rerateFallback]).toBe(5);
    expect(bucket!.adjusted).toBe(205);
    expect(r.coverage!.byCurrency.USD).toEqual({ listPriced: 100, listTotal: 130, fallback: 50 });
    reconciles(r);
  });

  it("re-rates a partly listed line on both paths", () => {
    const r = priceLines([line({ collected: 100, listedCollected: 60, listAmount: 90 })], {
      pricing: rerate({ fallbackUpliftPercent: 50 }),
      rules: [],
    });
    expect(r.buckets[0]!.adjusted).toBe(90 + 40 * 1.5);
  });

  it("only re-rates providers and services in scope", () => {
    const r = priceLines(
      [line({ collected: 100 }), line({ pluginId: "gcp", service: "Compute", collected: 100 })],
      { pricing: rerate({ scope: [{ pluginId: "gcp" }] }), rules: [] },
    );
    expect(r.buckets[0]!.adjusted).toBe(210);
    expect(r.coverage!.services).toEqual([
      { pluginId: "gcp", service: "Compute", currency: "USD", listPriced: 0, fallback: 100 },
    ]);
  });

  it("prefers a service uplift over a provider uplift over the default", () => {
    const p = rerate({
      fallbackUpliftPercent: 1,
      uplifts: [
        { pluginId: "aws", service: null, percent: 5 },
        { pluginId: "aws", service: "AmazonS3", percent: 20 },
      ],
    });
    const r = priceLines(
      [
        line({ collected: 100 }),
        line({ service: "AmazonS3", collected: 100 }),
        line({ pluginId: "gcp", collected: 100 }),
      ],
      { pricing: p, rules: [], withLineCosts: true },
    );
    expect(r.lineCosts).toEqual([105, 120, 101]);
  });
});

describe("priceLines: discount treatment", () => {
  it("retains provider discounts and credits by the configured share", () => {
    const r = priceLines(
      [
        line({ collected: 1000 }),
        line({ chargeType: "other", collected: -100 }), // an EDP-style discount
        line({ chargeType: "commitment_discount", collected: -50 }),
        line({ chargeType: "credit", collected: -200 }),
        line({ chargeType: "other", collected: 30 }), // a positive "other" is not a discount
      ],
      {
        pricing: pricing({
          discounts: { mode: "retain" },
          credits: { mode: "partial", passThroughPercent: 25 },
        }),
        rules: [],
      },
    );
    const b = r.buckets[0]!;
    expect(b.effects[PRICING_STEP_KEYS.discounts]).toBe(150);
    expect(b.effects[PRICING_STEP_KEYS.credits]).toBe(150);
    expect(b.adjusted).toBe(1000 - 100 - 50 - 200 + 30 + 300);
    reconciles(r);
  });

  it("retains commitment benefits only where a list price measures them", () => {
    const r = priceLines(
      [
        line({
          chargeType: "commitment_covered_usage",
          collected: 60,
          listedCollected: 60,
          listAmount: 100,
        }),
        line({ chargeType: "commitment_covered_usage", collected: 50 }),
      ],
      {
        pricing: pricing({ commitmentBenefits: { mode: "partial", passThroughPercent: 50 } }),
        rules: [],
      },
    );
    expect(r.buckets[0]!.effects[PRICING_STEP_KEYS.commitmentBenefits]).toBe(20);
    expect(r.warnings.join(" ")).toContain("no reported list price");
  });

  it("does not retain a commitment benefit twice on a re-rated line", () => {
    const r = priceLines(
      [
        line({
          chargeType: "commitment_covered_usage",
          collected: 60,
          listedCollected: 60,
          listAmount: 100,
        }),
      ],
      {
        pricing: pricing({
          rerate: { enabled: true, scope: [], fallbackUpliftPercent: 0, uplifts: [] },
          commitmentBenefits: { mode: "retain" },
        }),
        rules: [],
      },
    );
    expect(r.buckets[0]!.adjusted).toBe(100);
  });
});

describe("priceLines: billing rules", () => {
  it("compounds percentage rules exactly as the SQL path does", () => {
    const r = priceLines([line({ collected: 100 })], {
      pricing: DEFAULT_MANAGED_ACCOUNT_PRICING,
      rules: [rule({ kind: "percentage", percent: 10 }), rule({ kind: "percentage", percent: 10 })],
    });
    expect(r.buckets[0]!.adjusted).toBeCloseTo(121, 9);
    expect(r.effects.map((e) => e.totals.USD)).toEqual([10, 11]);
  });

  it("matches on tags the way SQL does: key presence, then value", () => {
    const rules = [
      rule({ kind: "percentage", percent: 100 }, { match: { tagKey: "env" } }),
      rule({ kind: "percentage", percent: 100 }, { match: { tagKey: "team", tagValue: "data" } }),
    ];
    const r = priceLines(
      [line({ tags: { env: "" } }), line({ tags: { team: "web" } }), line({ tags: {} })],
      { pricing: DEFAULT_MANAGED_ACCOUNT_PRICING, rules, withLineCosts: true },
    );
    expect(r.lineCosts).toEqual([200, 100, 100]);
  });

  it("evaluates expressions in order on the running cost", () => {
    const rules = [
      rule({ kind: "percentage", percent: 10 }, { priority: 1 }),
      rule(
        { kind: "expression", expression: 'if tag.env == "prod" then cost + 5' },
        { priority: 2, name: "Prod surcharge" },
      ),
    ];
    const r = priceLines([line({ tags: { env: "prod" } }), line({ tags: { env: "dev" } })], {
      pricing: DEFAULT_MANAGED_ACCOUNT_PRICING,
      rules,
      withLineCosts: true,
    });
    expect(r.lineCosts).toEqual([115, 110]);
    expect(r.effects.find((e) => e.label === "Prod surcharge")!.totals.USD).toBe(5);
    reconciles(r);
  });

  it("keeps a line's cost and reports when an expression fails on it", () => {
    const r = priceLines([line({ usage: 0 }), line({ usage: 10 })], {
      pricing: DEFAULT_MANAGED_ACCOUNT_PRICING,
      rules: [rule({ kind: "expression", expression: "cost / usage * 100" }, { name: "Per unit" })],
      withLineCosts: true,
    });
    expect(r.lineCosts).toEqual([100, 1000]);
    expect(r.expressionFailures).toEqual([
      { ruleId: expect.any(String), name: "Per unit", lines: 1, message: "Division by zero." },
    ]);
  });

  it("reports a stored expression that no longer parses instead of throwing", () => {
    const r = priceLines([line()], {
      pricing: DEFAULT_MANAGED_ACCOUNT_PRICING,
      rules: [rule({ kind: "expression", expression: "cost +" })],
    });
    expect(r.expressionFailures[0]!.message).toContain("ends too early");
    expect(r.buckets[0]!.adjusted).toBe(100);
  });

  it("applies marginal tiers per month and spreads the amount over the lines", () => {
    const tiered = rule({
      kind: "tiered",
      currency: "USD",
      tierMode: "marginal",
      tierScope: "overall",
      tiers: [
        { upTo: 10_000, percent: 8 },
        { upTo: 50_000, percent: 5 },
        { upTo: null, percent: 3 },
      ],
    });
    const r = priceLines(
      [
        line({ collected: 30_000 }),
        line({ collected: 30_000, service: "AmazonS3" }),
        line({ collected: 5_000, month: "2026-10" }),
      ],
      { pricing: DEFAULT_MANAGED_ACCOUNT_PRICING, rules: [tiered], withLineCosts: true },
    );
    // September: 10k at 8% + 40k at 5% + 10k at 3% = 800 + 2000 + 300 = 3100, split evenly.
    expect(r.lineCosts).toEqual([31_550, 31_550, 5_400]);
    reconciles(r);
  });

  it("applies whole-volume tiers per service", () => {
    const tiered = rule({
      kind: "tiered",
      currency: "USD",
      tierMode: "volume",
      tierScope: "per_service",
      tiers: [
        { upTo: 10_000, percent: 8 },
        { upTo: null, percent: 3 },
      ],
    });
    const r = priceLines(
      [line({ collected: 20_000 }), line({ collected: 5_000, service: "AmazonS3" })],
      { pricing: DEFAULT_MANAGED_ACCOUNT_PRICING, rules: [tiered], withLineCosts: true },
    );
    expect(r.lineCosts).toEqual([20_600, 5_400]);
  });

  it("skips other currencies with a warning", () => {
    const tiered = rule({
      kind: "tiered",
      currency: "USD",
      tierMode: "marginal",
      tierScope: "overall",
      tiers: [{ upTo: null, percent: 10 }],
    });
    const r = priceLines([line(), line({ currency: "EUR" })], {
      pricing: DEFAULT_MANAGED_ACCOUNT_PRICING,
      rules: [tiered],
    });
    expect(r.warnings[0]).toContain("EUR");
  });

  it("ignores reallocation, fixed and disabled rules", () => {
    const r = priceLines([line()], {
      pricing: DEFAULT_MANAGED_ACCOUNT_PRICING,
      rules: [
        rule({ kind: "fixed", amount: 10, currency: "USD", period: "monthly" }),
        rule({ kind: "reallocation", targetKind: "cost_centre", targetId: "x" }),
        { ...rule({ kind: "percentage", percent: 50 }), enabled: false },
      ],
    });
    expect(r.buckets[0]!.adjusted).toBe(100);
  });
});

describe("tierAdjustmentForVolume", () => {
  const tiers = [
    { upTo: 10_000, percent: 8 },
    { upTo: 50_000, percent: 5 },
    { upTo: null, percent: 3 },
  ];
  it.each([
    [0, 0, 0],
    [5_000, 400, 400],
    [10_000, 800, 500],
    [60_000, 3_100, 1_800],
  ])("volume %d → marginal %d, whole-volume %d", (volume, marginal, whole) => {
    expect(tierAdjustmentForVolume(tiers, "marginal", volume)).toBeCloseTo(marginal, 9);
    expect(tierAdjustmentForVolume(tiers, "volume", volume)).toBeCloseTo(whole, 9);
  });

  it("charges nothing on a negative month", () => {
    expect(tierAdjustmentForVolume(tiers, "marginal", -10)).toBe(0);
  });
});

describe("billing rules: the invoice-only kinds", () => {
  const base: BillingRuleInput = {
    name: "Tiered",
    enabled: true,
    priority: 0,
    match: {},
    adjustment: {
      kind: "tiered",
      currency: "usd",
      tierMode: "marginal",
      tierScope: "overall",
      tiers: [
        { upTo: 10_000, percent: 8 },
        { upTo: null, percent: 3 },
      ],
    },
  };

  it("normalizes and accepts a valid tiered rule", () => {
    const n = normalizeBillingRuleInput(base);
    expect(n.adjustment.currency).toBe("USD");
    expect(billingRuleInputError(n)).toBeNull();
  });

  it.each([
    [[], "at least one tier"],
    [[{ upTo: 10, percent: 1 }], "open-ended"],
    [
      [
        { upTo: 10, percent: 1 },
        { upTo: 5, percent: 1 },
        { upTo: null, percent: 1 },
      ],
      "greater than 10",
    ],
    [[{ upTo: null, percent: 5000 }], "between"],
  ])("refuses tiers %j", (tiers, fragment) => {
    const n = normalizeBillingRuleInput({ ...base, adjustment: { ...base.adjustment, tiers } });
    expect(billingRuleInputError(n)).toContain(fragment);
  });

  it("refuses an expression that does not parse, with its position", () => {
    const n = normalizeBillingRuleInput({
      ...base,
      adjustment: { kind: "expression", expression: "cost * $" },
    });
    expect(billingRuleInputError(n)).toBe(
      'Expression error at character 8: "$" is not allowed in a pricing expression.',
    );
  });

  it("only lets invoice-only kinds name customers", () => {
    const n = normalizeBillingRuleInput({
      ...base,
      adjustment: { kind: "percentage", percent: 5 },
      managedAccountIds: ["m1"],
    });
    expect(billingRuleInputError(n)).toContain("Only tiered and expression rules");
  });

  it("keeps invoice-only kinds out of the graph path and its caption", () => {
    const rules = [
      rule({ kind: "expression", expression: "cost * 2" }),
      rule({
        kind: "tiered",
        currency: "USD",
        tierMode: "marginal",
        tierScope: "overall",
        tiers: [{ upTo: null, percent: 1 }],
      }),
    ];
    expect(compileBillingRules(rules)).toEqual({ factors: [], reallocations: [], fixed: [] });
    expect(summarizeBillingRules(rules)).toEqual([]);
  });

  it("scopes a rule to its customers", () => {
    const scoped = rule({ kind: "expression", expression: "cost" }, { managedAccountIds: ["m1"] });
    expect(billingRuleAppliesToCustomer(scoped, "m1")).toBe(true);
    expect(billingRuleAppliesToCustomer(scoped, "m2")).toBe(false);
    expect(billingRuleAppliesToCustomer(scoped, null)).toBe(false);
    expect(billingRuleAppliesToCustomer(rule({ kind: "percentage", percent: 1 }), "m2")).toBe(true);
  });

  it("collects the tag keys the engine must group by", () => {
    expect(
      pricingTagKeys([
        rule({ kind: "percentage", percent: 1 }, { match: { tagKey: "team" } }),
        rule({ kind: "expression", expression: 'if tag.env == "prod" then cost' }),
        rule(
          { kind: "reallocation", targetKind: "account", targetId: "x" },
          { match: { tagKey: "ignored" } },
        ),
      ]),
    ).toEqual(["env", "team"]);
  });
});

describe("managedAccountPricingError", () => {
  it("accepts the default and refuses the edges of partial", () => {
    expect(managedAccountPricingError(DEFAULT_MANAGED_ACCOUNT_PRICING)).toBeNull();
    expect(
      managedAccountPricingError(
        pricing({ credits: { mode: "partial", passThroughPercent: 100 } }),
      ),
    ).toContain("between 0% and 100%");
  });

  it("refuses duplicate uplifts and out-of-range percentages", () => {
    const base = DEFAULT_MANAGED_ACCOUNT_PRICING.rerate;
    expect(
      managedAccountPricingError(pricing({ rerate: { ...base, fallbackUpliftPercent: 5000 } })),
    ).toContain("fallback uplift");
    expect(
      managedAccountPricingError(
        pricing({
          rerate: {
            ...base,
            uplifts: [
              { pluginId: "aws", service: null, percent: 1 },
              { pluginId: "aws", service: null, percent: 2 },
            ],
          },
        }),
      ),
    ).toContain("two fallback uplifts");
  });
});
