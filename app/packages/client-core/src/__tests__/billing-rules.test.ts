/**
 * The billing-rule model, independent of any query.
 *
 * The properties that matter here are the ones a reader has to be able to
 * assume when interpreting an adjusted number: the ordering is total, the
 * kinds compose the way the docs say, a fixed amount is pro-rated rather than
 * rounded to a whole period, and the validator refuses exactly the
 * combinations the API refuses (in the same words the form shows).
 */
import { describe, expect, it } from "vitest";
import {
  BILLING_RULE_LIMITS,
  billingAdjustmentsAreEmpty,
  billingRuleInputError,
  compileBillingRules,
  describeBillingRule,
  fixedRuleAmountForRange,
  fixedTotalsForRange,
  normalizeBillingRuleInput,
  orderBillingRules,
  summarizeBillingRules,
  type BillingRule,
  type BillingRuleInput,
} from "../billing-rules";

function rule(over: Partial<BillingRule> & Pick<BillingRule, "id" | "adjustment">): BillingRule {
  return {
    name: over.id,
    description: null,
    enabled: true,
    priority: 0,
    match: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function input(over: Partial<BillingRuleInput> = {}): BillingRuleInput {
  return {
    name: "Platform overhead",
    description: null,
    enabled: true,
    priority: 0,
    match: {},
    adjustment: { kind: "percentage", percent: 15 },
    ...over,
  };
}

describe("orderBillingRules", () => {
  it("orders by priority, then creation time, then id — total and deterministic", () => {
    const rules = [
      rule({ id: "c", priority: 1, adjustment: { kind: "percentage", percent: 1 } }),
      rule({
        id: "b",
        priority: 0,
        createdAt: "2026-02-01T00:00:00.000Z",
        adjustment: { kind: "percentage", percent: 1 },
      }),
      rule({
        id: "a",
        priority: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        adjustment: { kind: "percentage", percent: 1 },
      }),
    ];
    expect(orderBillingRules(rules).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("breaks a full tie by id so two clients never compile a different order", () => {
    const same = { priority: 0, createdAt: "2026-01-01T00:00:00.000Z" } as const;
    const rules = [
      rule({ id: "z", ...same, adjustment: { kind: "percentage", percent: 1 } }),
      rule({ id: "y", ...same, adjustment: { kind: "percentage", percent: 1 } }),
    ];
    expect(orderBillingRules(rules).map((r) => r.id)).toEqual(["y", "z"]);
    expect(orderBillingRules([...rules].reverse()).map((r) => r.id)).toEqual(["y", "z"]);
  });

  it("does not mutate the caller's array", () => {
    const rules = [
      rule({ id: "b", priority: 1, adjustment: { kind: "percentage", percent: 1 } }),
      rule({ id: "a", priority: 0, adjustment: { kind: "percentage", percent: 1 } }),
    ];
    orderBillingRules(rules);
    expect(rules.map((r) => r.id)).toEqual(["b", "a"]);
  });
});

describe("compileBillingRules", () => {
  it("splits the three kinds by how they are applied, in evaluation order", () => {
    const compiled = compileBillingRules([
      rule({ id: "m2", priority: 2, adjustment: { kind: "percentage", percent: 10 } }),
      rule({ id: "m1", priority: 1, adjustment: { kind: "percentage", percent: -5 } }),
      rule({
        id: "r1",
        priority: 3,
        adjustment: { kind: "reallocation", targetKind: "cost_centre", targetId: "cc" },
      }),
      rule({
        id: "f1",
        priority: 4,
        adjustment: { kind: "fixed", amount: 1000, currency: "USD", period: "monthly" },
      }),
    ]);
    expect(compiled.factors.map((f) => f.ruleId)).toEqual(["m1", "m2"]);
    expect(compiled.factors.map((f) => f.factor)).toEqual([0.95, 1.1]);
    expect(compiled.reallocations.map((r) => r.ruleId)).toEqual(["r1"]);
    expect(compiled.fixed.map((f) => f.ruleId)).toEqual(["f1"]);
  });

  it("drops disabled rules — one place decides what is in force", () => {
    const compiled = compileBillingRules([
      rule({ id: "off", enabled: false, adjustment: { kind: "percentage", percent: 900 } }),
    ]);
    expect(billingAdjustmentsAreEmpty(compiled)).toBe(true);
  });

  it("drops a reallocation with no target rather than moving spend nowhere", () => {
    const compiled = compileBillingRules([
      rule({
        id: "half",
        adjustment: { kind: "reallocation", targetKind: "account", targetId: null },
      }),
    ]);
    expect(compiled.reallocations).toEqual([]);
  });

  it("turns percentages into multipliers, negative ones included", () => {
    const compiled = compileBillingRules([
      rule({ id: "a", priority: 0, adjustment: { kind: "percentage", percent: 100 } }),
      rule({ id: "b", priority: 1, adjustment: { kind: "percentage", percent: -100 } }),
    ]);
    expect(compiled.factors.map((f) => f.factor)).toEqual([2, 0]);
  });
});

describe("fixedRuleAmountForRange", () => {
  it("charges a daily amount once per day of the inclusive range", () => {
    expect(
      fixedRuleAmountForRange({ amount: 50, period: "daily" }, "2026-08-01", "2026-08-10"),
    ).toBe(500);
  });

  it("charges a monthly amount once for a whole calendar month", () => {
    expect(
      fixedRuleAmountForRange({ amount: 3000, period: "monthly" }, "2026-09-01", "2026-09-30"),
    ).toBe(3000);
  });

  it("pro-rates a partial month rather than charging it whole or dropping it", () => {
    // Ten days of a thirty-day September: a $3,000/month overhead shown in full
    // on a ten-day chart reconciles against nothing, and shown as zero it
    // silently disappears.
    expect(
      fixedRuleAmountForRange({ amount: 3000, period: "monthly" }, "2026-09-01", "2026-09-10"),
    ).toBeCloseTo(1000, 10);
  });

  it("sums whole and partial months across a multi-month range", () => {
    // 31 Aug days (1 whole month) + 10 of September's 30.
    const total = fixedRuleAmountForRange(
      { amount: 3000, period: "monthly" },
      "2026-08-01",
      "2026-09-10",
    );
    expect(total).toBeCloseTo(3000 + 1000, 10);
  });

  it("handles February's short month without special-casing it", () => {
    expect(
      fixedRuleAmountForRange({ amount: 2800, period: "monthly" }, "2026-02-01", "2026-02-14"),
    ).toBeCloseTo((2800 * 14) / 28, 10);
  });

  it("is zero for an inverted range rather than negative", () => {
    expect(
      fixedRuleAmountForRange({ amount: 100, period: "daily" }, "2026-08-10", "2026-08-01"),
    ).toBe(0);
  });

  it("sums per currency and never merges two currencies", () => {
    const totals = fixedTotalsForRange(
      [
        {
          ruleId: "a",
          name: "A",
          amount: 100,
          currency: "USD",
          period: "daily",
          targetKind: null,
          targetId: null,
        },
        {
          ruleId: "b",
          name: "B",
          amount: 50,
          currency: "EUR",
          period: "daily",
          targetKind: null,
          targetId: null,
        },
        {
          ruleId: "c",
          name: "C",
          amount: 25,
          currency: "USD",
          period: "daily",
          targetKind: null,
          targetId: null,
        },
      ],
      "2026-08-01",
      "2026-08-02",
    );
    expect(totals).toEqual({ USD: 250, EUR: 100 });
  });
});

describe("billingRuleInputError", () => {
  it("accepts a well-formed markup", () => {
    expect(billingRuleInputError(input())).toBeNull();
  });

  it("refuses a rule with no name", () => {
    expect(billingRuleInputError(input({ name: "  " }))).toMatch(/needs a name/);
  });

  it("refuses a 0% markup rather than storing a rule that changes nothing", () => {
    expect(
      billingRuleInputError(input({ adjustment: { kind: "percentage", percent: 0 } })),
    ).toMatch(/changes nothing/);
  });

  it("refuses a discount larger than the cost", () => {
    expect(
      billingRuleInputError(
        input({ adjustment: { kind: "percentage", percent: BILLING_RULE_LIMITS.minPercent - 1 } }),
      ),
    ).toMatch(/between -100% and 1000%/);
  });

  it("refuses a percentage rule that carries an amount", () => {
    expect(
      billingRuleInputError(input({ adjustment: { kind: "percentage", percent: 5, amount: 10 } })),
    ).toMatch(/cannot carry an amount/);
  });

  it("refuses a fixed rule that carries a percentage", () => {
    expect(
      billingRuleInputError(
        input({
          adjustment: {
            kind: "fixed",
            amount: 100,
            currency: "USD",
            period: "monthly",
            percent: 5,
          },
        }),
      ),
    ).toMatch(/cannot carry a percentage/);
  });

  it("refuses a fixed rule with no currency", () => {
    expect(
      billingRuleInputError(
        input({ adjustment: { kind: "fixed", amount: 100, period: "monthly" } }),
      ),
    ).toMatch(/three-letter currency code/);
  });

  it("refuses a reallocation with no target — it would move spend nowhere", () => {
    expect(billingRuleInputError(input({ adjustment: { kind: "reallocation" } }))).toMatch(
      /cost centre or an account/,
    );
  });

  it("refuses a markup that tries to move spend", () => {
    expect(
      billingRuleInputError(
        input({
          adjustment: {
            kind: "percentage",
            percent: 10,
            targetKind: "account",
            targetId: "acct-a",
          },
        }),
      ),
    ).toMatch(/cannot move spend/);
  });

  it("refuses a tag value with no tag key", () => {
    expect(billingRuleInputError(input({ match: { tagValue: "platform" } }))).toMatch(
      /needs a tag key/,
    );
  });
});

describe("normalizeBillingRuleInput", () => {
  it("uppercases a currency rather than rejecting it — that is not a mistake", () => {
    const out = normalizeBillingRuleInput(
      input({ adjustment: { kind: "fixed", amount: 10, currency: " usd ", period: "monthly" } }),
    );
    expect(out.adjustment.currency).toBe("USD");
    expect(billingRuleInputError(out)).toBeNull();
  });

  it("clears fields the kind cannot use, so one state means one thing", () => {
    const out = normalizeBillingRuleInput(
      input({
        adjustment: {
          kind: "percentage",
          percent: 5,
          amount: 999,
          currency: "USD",
          period: "daily",
          targetKind: "account",
          targetId: "acct-a",
        },
      }),
    );
    expect(out.adjustment).toEqual({
      kind: "percentage",
      percent: 5,
      amount: null,
      currency: null,
      period: null,
      targetKind: null,
      targetId: null,
    });
  });

  it("collapses half a target to no target", () => {
    const out = normalizeBillingRuleInput(
      input({
        adjustment: {
          kind: "fixed",
          amount: 10,
          currency: "USD",
          period: "monthly",
          targetKind: "cost_centre",
          targetId: "   ",
        },
      }),
    );
    expect(out.adjustment.targetKind).toBeNull();
    expect(out.adjustment.targetId).toBeNull();
  });

  it("drops a tag value whose key was blank", () => {
    const out = normalizeBillingRuleInput(input({ match: { tagKey: " ", tagValue: "platform" } }));
    expect(out.match).toEqual({});
  });
});

describe("summarizeBillingRules", () => {
  it("names only the enabled rules, in evaluation order, with a readable summary", () => {
    const summary = summarizeBillingRules([
      rule({
        id: "b",
        name: "Overhead",
        priority: 1,
        match: { tagKey: "team", tagValue: "platform" },
        adjustment: { kind: "percentage", percent: 15 },
      }),
      rule({
        id: "a",
        name: "EDP discount",
        priority: 0,
        adjustment: { kind: "percentage", percent: -8 },
      }),
      rule({
        id: "off",
        name: "Paused",
        enabled: false,
        adjustment: { kind: "percentage", percent: 50 },
      }),
    ]);
    expect(summary.map((r) => r.name)).toEqual(["EDP discount", "Overhead"]);
    expect(summary[1]!.summary).toBe("+15% on tag team=platform");
    expect(summary[0]!.summary).toBe("-8% on all spend");
  });

  it("describes a catch-all rule as applying to all spend, not to nothing", () => {
    expect(describeBillingRule({ match: {}, adjustment: { kind: "percentage", percent: 3 } })).toBe(
      "+3% on all spend",
    );
  });
});
