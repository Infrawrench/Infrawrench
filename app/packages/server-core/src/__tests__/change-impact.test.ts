import { describe, expect, it } from "vitest";

import {
  changeImpactFetchRange,
  computeChangeCostImpact,
  sumChangeCostImpacts,
  type ChangeImpactInput,
} from "../cost/change-impact";

/**
 * A resource that spent `amount` every day across `[from, to]`. Real cost rows
 * are one row per day the provider billed, which is exactly this.
 */
function flat(from: string, to: string, amount: number): Array<{ day: string; amount: number }> {
  const out: Array<{ day: string; amount: number }> = [];
  const d = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  while (d <= end) {
    out.push({ day: d.toISOString().slice(0, 10), amount });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function input(overrides: Partial<ChangeImpactInput> = {}): ChangeImpactInput {
  return {
    eventDay: "2026-06-15",
    today: "2026-07-01",
    windowDays: 7,
    costBasis: "cash",
    coverage: { firstDay: "2026-01-01", lastDay: "2026-06-30" },
    series: [],
    periodNative: false,
    overlappingChanges: 0,
    costAddressable: true,
    ...overrides,
  };
}

describe("computeChangeCostImpact — windows", () => {
  it("excludes the change's own day from both windows", () => {
    const result = computeChangeCostImpact(
      input({ series: [{ currency: "USD", points: flat("2026-06-01", "2026-06-30", 1) }] }),
    );
    expect(result.before).toEqual({ from: "2026-06-08", to: "2026-06-14" });
    expect(result.after).toEqual({ from: "2026-06-16", to: "2026-06-22" });
  });

  it("never reaches into today, because an accruing day always reads as a dip", () => {
    // The change was 3 days ago, so only 2 complete days follow it.
    const result = computeChangeCostImpact(
      input({
        eventDay: "2026-06-28",
        today: "2026-07-01",
        coverage: { firstDay: "2026-01-01", lastDay: "2026-07-01" },
        series: [{ currency: "USD", points: flat("2026-06-01", "2026-06-30", 2) }],
      }),
    );
    expect(result.after).toEqual({ from: "2026-06-29", to: "2026-06-30" });
    expect(result.effectiveWindowDays).toBe(2);
    expect(result.reasons).toContain("window_clamped");
  });

  it("clamps symmetrically, so both means average the same number of days", () => {
    const result = computeChangeCostImpact(
      input({
        eventDay: "2026-06-28",
        today: "2026-07-01",
        coverage: { firstDay: "2026-01-01", lastDay: "2026-06-30" },
        series: [{ currency: "USD", points: flat("2026-06-01", "2026-06-30", 2) }],
      }),
    );
    expect(result.before).toEqual({ from: "2026-06-26", to: "2026-06-27" });
    expect(result.after).toEqual({ from: "2026-06-29", to: "2026-06-30" });
  });
});

describe("computeChangeCostImpact — insufficient data", () => {
  it("reports insufficient_data when only one comparable day exists per side", () => {
    const result = computeChangeCostImpact(
      input({
        eventDay: "2026-06-29",
        today: "2026-07-01",
        coverage: { firstDay: "2026-01-01", lastDay: "2026-06-30" },
        series: [{ currency: "USD", points: flat("2026-06-01", "2026-06-30", 5) }],
      }),
    );
    expect(result.status).toBe("insufficient_data");
    expect(result.reasons).toContain("short_window");
    expect(result.series).toEqual([]);
  });

  it("says the collection had not started rather than inventing a baseline", () => {
    const result = computeChangeCostImpact(
      input({
        eventDay: "2026-06-15",
        coverage: { firstDay: "2026-06-15", lastDay: "2026-06-30" },
      }),
    );
    expect(result.status).toBe("unknown");
    expect(result.reasons).toEqual(["no_coverage_before"]);
  });

  it("says not enough time has passed when the change is newer than the data", () => {
    const result = computeChangeCostImpact(
      input({
        eventDay: "2026-06-30",
        today: "2026-07-01",
        coverage: { firstDay: "2026-01-01", lastDay: "2026-06-30" },
      }),
    );
    expect(result.status).toBe("unknown");
    expect(result.reasons).toEqual(["no_coverage_after"]);
  });
});

describe("computeChangeCostImpact — the null that must never become a zero", () => {
  it("returns unknown, not $0/day, for a resource with no cost data at all", () => {
    const result = computeChangeCostImpact(input({ series: [] }));
    expect(result.status).toBe("unknown");
    expect(result.reasons).toContain("no_cost_data");
    expect(result.series).toEqual([]);
  });

  it("returns unknown for a resource with no provider id to key spend against", () => {
    const result = computeChangeCostImpact(input({ costAddressable: false }));
    expect(result.status).toBe("unknown");
    expect(result.reasons).toEqual(["no_cost_identity"]);
  });

  it("refuses to read a period-native provider with a day window", () => {
    // A monthly-native plugin files a whole invoice against the 1st, so a
    // 7-day window either swallows a month's bill or misses it entirely.
    const result = computeChangeCostImpact(
      input({
        periodNative: true,
        series: [{ currency: "EUR", points: [{ day: "2026-06-01", amount: 900 }] }],
      }),
    );
    expect(result.status).toBe("unknown");
    expect(result.reasons).toEqual(["period_native_provider"]);
  });

  it("does report a real zero when the resource was billed on one side only", () => {
    // A resource that was deleted: it cost money before and nothing after.
    // That IS a measurement — the days after are covered and genuinely empty.
    const result = computeChangeCostImpact(
      input({ series: [{ currency: "USD", points: flat("2026-06-08", "2026-06-14", 3) }] }),
    );
    expect(result.status).toBe("measured");
    expect(result.series[0]).toMatchObject({
      beforePerDay: 3,
      afterPerDay: 0,
      deltaPerDay: -3,
      deltaPercent: -100,
    });
  });

  it("has no percentage for a resource that came into being", () => {
    const result = computeChangeCostImpact(
      input({ series: [{ currency: "USD", points: flat("2026-06-16", "2026-06-22", 4) }] }),
    );
    expect(result.series[0]?.deltaPerDay).toBe(4);
    expect(result.series[0]?.deltaPercent).toBeNull();
  });
});

describe("computeChangeCostImpact — attribution honesty", () => {
  it("names overlapping changes and drops a confidence tier", () => {
    const clean = computeChangeCostImpact(
      input({ series: [{ currency: "USD", points: flat("2026-06-01", "2026-06-30", 2) }] }),
    );
    expect(clean.confidence).toBe("high");
    expect(clean.reasons).not.toContain("overlapping_changes");

    const muddied = computeChangeCostImpact(
      input({
        overlappingChanges: 3,
        series: [{ currency: "USD", points: flat("2026-06-01", "2026-06-30", 2) }],
      }),
    );
    expect(muddied.confidence).toBe("medium");
    expect(muddied.reasons).toContain("overlapping_changes");
    expect(muddied.overlappingChanges).toBe(3);
  });

  it("drops to low confidence on a short window and to none when both apply", () => {
    const short = computeChangeCostImpact(
      input({
        eventDay: "2026-06-28",
        today: "2026-07-01",
        coverage: { firstDay: "2026-01-01", lastDay: "2026-06-30" },
        overlappingChanges: 1,
        series: [{ currency: "USD", points: flat("2026-06-01", "2026-06-30", 2) }],
      }),
    );
    expect(short.effectiveWindowDays).toBe(2);
    expect(short.confidence).toBe("none");
  });

  it("echoes the basis it was asked for, so no surface can print a bare number", () => {
    const amortized = computeChangeCostImpact(
      input({
        costBasis: "amortized",
        series: [{ currency: "USD", points: flat("2026-06-01", "2026-06-30", 1) }],
      }),
    );
    expect(amortized.costBasis).toBe("amortized");
  });
});

describe("computeChangeCostImpact — currencies", () => {
  it("compares each currency on its own and never sums them", () => {
    const result = computeChangeCostImpact(
      input({
        series: [
          { currency: "USD", points: flat("2026-06-16", "2026-06-22", 10) },
          { currency: "EUR", points: flat("2026-06-08", "2026-06-14", 7) },
        ],
      }),
    );
    expect(result.series).toHaveLength(2);
    const usd = result.series.find((s) => s.currency === "USD");
    const eur = result.series.find((s) => s.currency === "EUR");
    expect(usd?.deltaPerDay).toBe(10);
    expect(eur?.deltaPerDay).toBe(-7);
  });
});

describe("computeChangeCostImpact — late-arriving cost", () => {
  it("recomputes to the right answer as the provider fills the window in", () => {
    // Day 1 after a deploy: the provider has published two days either side.
    // Same event, same window request — only the data differs.
    const early = computeChangeCostImpact(
      input({
        eventDay: "2026-06-15",
        today: "2026-06-18",
        coverage: { firstDay: "2026-01-01", lastDay: "2026-06-17" },
        series: [
          {
            currency: "USD",
            points: [
              ...flat("2026-06-13", "2026-06-14", 1),
              ...flat("2026-06-16", "2026-06-17", 2),
            ],
          },
        ],
      }),
    );
    expect(early.status).toBe("measured");
    expect(early.effectiveWindowDays).toBe(2);
    expect(early.confidence).toBe("low");
    expect(early.series[0]?.deltaPerDay).toBe(1);

    // A week later the full window exists — and the true rise was larger,
    // because the first days after the deploy were partial provider days.
    const settled = computeChangeCostImpact(
      input({
        eventDay: "2026-06-15",
        today: "2026-06-24",
        coverage: { firstDay: "2026-01-01", lastDay: "2026-06-23" },
        series: [
          {
            currency: "USD",
            points: [
              ...flat("2026-06-08", "2026-06-14", 1),
              ...flat("2026-06-16", "2026-06-22", 5),
            ],
          },
        ],
      }),
    );
    expect(settled.effectiveWindowDays).toBe(7);
    expect(settled.confidence).toBe("high");
    expect(settled.series[0]?.deltaPerDay).toBe(4);
    expect(settled.reasons).not.toContain("window_clamped");
  });

  it("turns a restated day into a different answer without any invalidation step", () => {
    const before = computeChangeCostImpact(
      input({ series: [{ currency: "USD", points: flat("2026-06-16", "2026-06-22", 3) }] }),
    );
    const restated = computeChangeCostImpact(
      input({
        series: [
          {
            currency: "USD",
            // The provider restated one day upward, as they do.
            points: flat("2026-06-16", "2026-06-22", 3).map((p) =>
              p.day === "2026-06-18" ? { ...p, amount: 10 } : p,
            ),
          },
        ],
      }),
    );
    expect(before.series[0]?.deltaPerDay).toBe(3);
    expect(restated.series[0]?.deltaPerDay).toBe(4);
  });
});

describe("sumChangeCostImpacts — multi-resource deploys", () => {
  const measured = (currency: string, delta: number, confidence: "high" | "low" = "high") =>
    computeChangeCostImpact(
      input({
        overlappingChanges: confidence === "low" ? 5 : 0,
        series: [{ currency, points: flat("2026-06-16", "2026-06-22", delta) }],
      }),
    );

  it("sums the breakdown per currency so the rows add up to the total", () => {
    const { total, unknownResources } = sumChangeCostImpacts([
      measured("USD", 2),
      measured("USD", 3),
      measured("EUR", 1),
    ]);
    expect(unknownResources).toBe(0);
    expect(total).toEqual([
      { currency: "USD", deltaPerDay: 5 },
      { currency: "EUR", deltaPerDay: 1 },
    ]);
  });

  it("leaves unmeasurable resources out of the total rather than adding zero", () => {
    const { total, unknownResources } = sumChangeCostImpacts([
      measured("USD", 4),
      computeChangeCostImpact(input({ costAddressable: false })),
      computeChangeCostImpact(input({ series: [] })),
    ]);
    expect(total).toEqual([{ currency: "USD", deltaPerDay: 4 }]);
    expect(unknownResources).toBe(2);
  });

  it("takes the weakest contributor's confidence", () => {
    const { confidence } = sumChangeCostImpacts([measured("USD", 4), measured("USD", 1, "low")]);
    expect(confidence).toBe("medium");
  });

  it("reports no confidence when nothing could be measured", () => {
    const { confidence, total } = sumChangeCostImpacts([
      computeChangeCostImpact(input({ series: [] })),
    ]);
    expect(confidence).toBe("none");
    expect(total).toEqual([]);
  });
});

describe("changeImpactFetchRange", () => {
  it("spans every window a batch could need, in one read", () => {
    expect(changeImpactFetchRange(["2026-06-15", "2026-06-01"], 7)).toEqual({
      from: "2026-05-25",
      to: "2026-06-22",
    });
  });

  it("is null for an empty batch, so no query is issued at all", () => {
    expect(changeImpactFetchRange([], 7)).toBeNull();
  });
});
