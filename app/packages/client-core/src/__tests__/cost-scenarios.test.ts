import { describe, expect, it } from "vitest";

import {
  applyCostScenario,
  costScenarioModelInputError,
  costScenarioScopeKey,
  scenarioScopeExcluded,
  type CostScenarioAdjustment,
  type CostScenarioModelInput,
  type ScenarioDayPoint,
} from "../cost-scenarios";
import type { CostFilter } from "../costs";

/**
 * The scenario composition engine. Four properties are load-bearing and every
 * one of them is pinned here:
 *
 * 1. a scenario only ever touches the days it was handed — history cannot move;
 * 2. the baseline it was computed from is returned untouched to the caller;
 * 3. overlapping adjustments compose in the defined order (rate changes against
 *    the trend first, absolute amounts added afterwards); and
 * 4. a scoped adjustment does not touch out-of-scope spend.
 */

const model = { id: "m1", name: "Q4 plan", currency: "USD" };

function adjustment(over: Partial<CostScenarioAdjustment>): CostScenarioAdjustment {
  return {
    id: "a1",
    label: "Adjustment",
    kind: "one_off",
    startDate: "2026-09-02",
    endDate: null,
    amountCents: 100_000,
    currency: "USD",
    period: null,
    percent: null,
    scope: [],
    ...over,
  };
}

const baseline: ScenarioDayPoint[] = [
  { day: "2026-09-01", amount: 100 },
  { day: "2026-09-02", amount: 100 },
  { day: "2026-09-03", amount: 100 },
];

describe("applyCostScenario", () => {
  it("returns exactly the days it was handed, and mutates none of them", () => {
    const input = baseline.map((p) => ({ ...p }));
    const result = applyCostScenario({
      model,
      adjustments: [adjustment({})],
      baseline: input,
    });

    expect(result.points.map((p) => p.bucket)).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
    // The baseline array the caller owns is the untouched trend — the response
    // carries both, so "what did the trend say before the scenario" is always
    // answerable.
    expect(input).toEqual(baseline);
  });

  it("ignores an adjustment dated before the projected region entirely", () => {
    // A recurring cost that started in June is a perfectly sensible thing to
    // describe; it simply cannot change a day that already has real spend
    // behind it, because those days are never handed to this function.
    const result = applyCostScenario({
      model,
      adjustments: [adjustment({ kind: "recurring", period: "daily", startDate: "2026-06-01" })],
      baseline,
    });
    // Every projected day is in the window, so all three move — and none of the
    // observed days exist here to move at all.
    expect(result.points.map((p) => p.amount)).toEqual([1100, 1100, 1100]);
  });

  it("puts a one-off on exactly its own day", () => {
    const result = applyCostScenario({
      model,
      adjustments: [adjustment({ amountCents: 50_000, startDate: "2026-09-02" })],
      baseline,
    });
    expect(result.points.map((p) => p.amount)).toEqual([100, 600, 100]);
    expect(result.totalDelta).toBe(500);
    expect(result.contributions).toEqual([
      { adjustmentId: "a1", label: "Adjustment", kind: "one_off", amount: 500 },
    ]);
  });

  it("spreads a monthly recurring amount evenly across the month's days", () => {
    const september: ScenarioDayPoint[] = [
      { day: "2026-09-10", amount: 0 },
      { day: "2026-09-11", amount: 0 },
    ];
    const result = applyCostScenario({
      model,
      adjustments: [
        adjustment({
          kind: "recurring",
          period: "monthly",
          amountCents: 300_000, // $3,000/month over a 30-day September
          startDate: "2026-09-01",
        }),
      ],
      baseline: september,
    });
    expect(result.points.map((p) => p.amount)).toEqual([100, 100]);
  });

  it("stops a recurring adjustment on its end date", () => {
    const result = applyCostScenario({
      model,
      adjustments: [
        adjustment({
          kind: "recurring",
          period: "daily",
          amountCents: 10_000,
          startDate: "2026-09-01",
          endDate: "2026-09-02",
        }),
      ],
      baseline,
    });
    expect(result.points.map((p) => p.amount)).toEqual([200, 200, 100]);
  });

  describe("composition order", () => {
    it("applies rate changes to the trend, then adds absolute amounts", () => {
      // −50% and a $1,000 one-off on the same day. Rates first means
      // 100 × 0.5 + 1000 = 1050. Amounts first would give (100 + 1000) × 0.5 =
      // 550 — silently halving a number the user typed in full.
      const result = applyCostScenario({
        model,
        adjustments: [
          adjustment({ id: "buy", label: "Licence", amountCents: 100_000 }),
          adjustment({
            id: "cut",
            label: "Migration",
            kind: "rate_change",
            percent: -50,
            amountCents: null,
            currency: null,
            startDate: "2026-09-01",
          }),
        ],
        baseline,
      });
      expect(result.points.map((p) => p.amount)).toEqual([50, 1050, 50]);
    });

    it("composes two overlapping rate changes additively, order-independently", () => {
      // Both are measured against the same untouched trend, so +10% and −20%
      // is −10% (90), not ×1.1×0.8 (88) — and swapping them cannot matter.
      const rates: CostScenarioAdjustment[] = [
        adjustment({
          id: "up",
          kind: "rate_change",
          percent: 10,
          amountCents: null,
          currency: null,
          startDate: "2026-09-01",
        }),
        adjustment({
          id: "down",
          kind: "rate_change",
          percent: -20,
          amountCents: null,
          currency: null,
          startDate: "2026-09-01",
        }),
      ];
      const forwards = applyCostScenario({ model, adjustments: rates, baseline });
      const backwards = applyCostScenario({
        model,
        adjustments: [...rates].reverse(),
        baseline,
      });
      expect(forwards.points.map((p) => p.amount)).toEqual([90, 90, 90]);
      expect(backwards.points.map((p) => p.amount)).toEqual(forwards.points.map((p) => p.amount));
    });

    it("clamps a day at zero without erasing an amount added on top", () => {
      const result = applyCostScenario({
        model,
        adjustments: [
          adjustment({
            id: "off",
            kind: "rate_change",
            percent: -100,
            amountCents: null,
            currency: null,
            startDate: "2026-09-01",
          }),
          adjustment({ id: "buy", amountCents: 20_000, startDate: "2026-09-02" }),
        ],
        baseline,
      });
      expect(result.points.map((p) => p.amount)).toEqual([0, 200, 0]);
    });
  });

  describe("scoping", () => {
    const awsScope: CostFilter[] = [{ dimension: "provider", op: "in", values: ["aws"] }];

    it("measures a scoped rate change against its own sub-baseline only", () => {
      // The chart totals 100/day; AWS is 40 of it. −50% on AWS takes 20 off,
      // never 50 — the other 60 is out of scope and must not move.
      const scoped = new Map<string, ScenarioDayPoint[]>([
        [costScenarioScopeKey(awsScope), baseline.map((p) => ({ day: p.day, amount: 40 }))],
      ]);
      const result = applyCostScenario({
        model,
        adjustments: [
          adjustment({
            kind: "rate_change",
            percent: -50,
            amountCents: null,
            currency: null,
            startDate: "2026-09-01",
            scope: awsScope,
          }),
        ],
        baseline,
        scopedBaselines: scoped,
      });
      expect(result.points.map((p) => p.amount)).toEqual([80, 80, 80]);
    });

    it("contributes nothing when the scope has no measurable spend", () => {
      const result = applyCostScenario({
        model,
        adjustments: [
          adjustment({
            kind: "rate_change",
            percent: -50,
            amountCents: null,
            currency: null,
            startDate: "2026-09-01",
            scope: awsScope,
          }),
        ],
        baseline,
        // No sub-baseline fetched: an empty scope must never fall back to the
        // whole chart, which would silently widen the adjustment.
        scopedBaselines: new Map(),
      });
      expect(result.points.map((p) => p.amount)).toEqual([100, 100, 100]);
      expect(result.totalDelta).toBe(0);
    });

    it("leaves an amount out when the chart's own filters exclude its scope", () => {
      const result = applyCostScenario({
        model,
        adjustments: [
          adjustment({
            label: "GCP commitment",
            amountCents: 4_000_000,
            scope: [{ dimension: "provider", op: "in", values: ["gcp"] }],
          }),
        ],
        baseline,
        chartFilters: [{ dimension: "provider", op: "in", values: ["aws"] }],
      });
      expect(result.points.map((p) => p.amount)).toEqual([100, 100, 100]);
      expect(result.outOfScope).toEqual(["GCP commitment"]);
    });
  });

  it("converts amounts at the supplied rate and says it did", () => {
    const result = applyCostScenario({
      model: { ...model, currency: "EUR" },
      adjustments: [adjustment({ amountCents: 10_000, currency: "EUR" })],
      baseline,
      amountRate: 1.1,
      currency: "USD",
      convertedFrom: "EUR",
    });
    expect(result.points[1]?.amount).toBe(210);
    expect(result.currency).toBe("USD");
    expect(result.convertedFrom).toBe("EUR");
  });
});

describe("scenarioScopeExcluded", () => {
  it("excludes a disjoint `in` filter", () => {
    expect(
      scenarioScopeExcluded(
        [{ dimension: "provider", op: "in", values: ["gcp"] }],
        [{ dimension: "provider", op: "in", values: ["aws"] }],
      ),
    ).toBe(true);
  });

  it("excludes a scope the chart explicitly filters out", () => {
    expect(
      scenarioScopeExcluded(
        [{ dimension: "provider", op: "in", values: ["gcp"] }],
        [{ dimension: "provider", op: "not_in", values: ["gcp", "azure"] }],
      ),
    ).toBe(true);
  });

  it("keeps anything it cannot prove disjoint", () => {
    expect(
      scenarioScopeExcluded(
        [{ dimension: "service", op: "in", values: ["AmazonEC2"] }],
        [{ dimension: "provider", op: "in", values: ["aws"] }],
      ),
    ).toBe(false);
    expect(scenarioScopeExcluded([], [])).toBe(false);
  });
});

describe("costScenarioModelInputError", () => {
  const valid: CostScenarioModelInput = {
    name: "Q4 plan",
    currency: "USD",
    adjustments: [adjustment({})],
  };

  it("accepts a well-formed model", () => {
    expect(costScenarioModelInputError(valid)).toBeNull();
  });

  it("refuses an empty model", () => {
    expect(costScenarioModelInputError({ ...valid, adjustments: [] })).toMatch(
      /at least one adjustment/,
    );
  });

  it("refuses a model that mixes currencies", () => {
    const error = costScenarioModelInputError({
      ...valid,
      adjustments: [adjustment({}), adjustment({ id: "a2", currency: "EUR" })],
    });
    expect(error).toMatch(/one currency/);
  });

  it("refuses a rate change carrying an amount, and an amount carrying a percent", () => {
    expect(
      costScenarioModelInputError({
        ...valid,
        adjustments: [adjustment({ kind: "rate_change", percent: -10 })],
      }),
    ).toMatch(/not an amount/);
    expect(
      costScenarioModelInputError({
        ...valid,
        adjustments: [adjustment({ percent: -10 })],
      }),
    ).toMatch(/no percent/);
  });

  it("refuses an end date on a one-off, and an end before the start", () => {
    expect(
      costScenarioModelInputError({
        ...valid,
        adjustments: [adjustment({ endDate: "2026-09-30" })],
      }),
    ).toMatch(/one-off/);
    expect(
      costScenarioModelInputError({
        ...valid,
        adjustments: [
          adjustment({
            kind: "recurring",
            period: "monthly",
            startDate: "2026-09-10",
            endDate: "2026-09-01",
          }),
        ],
      }),
    ).toMatch(/ends before it starts/);
  });
});
