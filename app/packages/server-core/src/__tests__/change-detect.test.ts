import { describe, expect, it } from "vitest";
import {
  CHANGE_EVALUATION_DAYS,
  changeWindows,
  detectChanges,
  isoWeekKey,
  windowTotals,
  type ChangeGroupTotals,
  type ChangeSeriesGroup,
} from "../cost/change-detect";
import { convertGroups } from "../cost/currency-convert";

const BOTH = { thresholdPercent: null, thresholdAmountCents: null, direction: "both" as const };

/** A stated org exchange rate with the bookkeeping fields stubbed. */
function rate(fromCurrency: string, toCurrency: string, value: string) {
  return {
    id: `${fromCurrency}-${toCurrency}`,
    fromCurrency,
    toCurrency,
    rate: value,
    effectiveFrom: "2026-01-01",
    createdBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function totals(
  previousAmount: number,
  currentAmount: number,
  key = "",
  currency = "USD",
): ChangeGroupTotals {
  return { key, currency, previousAmount, currentAmount };
}

describe("changeWindows — daily", () => {
  it("compares each complete day to the same weekday one week earlier", () => {
    const windows = changeWindows("daily", "2026-08-10");
    expect(windows).toHaveLength(CHANGE_EVALUATION_DAYS);
    // Oldest first, so a day that only now looks changed fires first.
    expect(windows[0]).toEqual({
      current: { from: "2026-08-07", to: "2026-08-07" },
      previous: { from: "2026-07-31", to: "2026-07-31" },
      periodKey: "2026-08-07",
    });
    expect(windows[2]).toEqual({
      current: { from: "2026-08-09", to: "2026-08-09" },
      previous: { from: "2026-08-02", to: "2026-08-02" },
      periodKey: "2026-08-09",
    });
  });

  it("never includes the accruing current day", () => {
    for (const w of changeWindows("daily", "2026-08-10")) {
      expect(w.current.to < "2026-08-10").toBe(true);
    }
  });

  it("re-evaluating the same day on a later pass produces the same period key", () => {
    const monday = changeWindows("daily", "2026-08-10").map((w) => w.periodKey);
    const tuesday = changeWindows("daily", "2026-08-11").map((w) => w.periodKey);
    // Two of Monday's three windows are re-examined on Tuesday under
    // identical keys — that is what lets the unique index absorb re-fires.
    expect(tuesday.filter((k) => monday.includes(k))).toEqual(["2026-08-08", "2026-08-09"]);
  });
});

describe("changeWindows — weekly", () => {
  it("compares the last 7 complete days to the prior 7", () => {
    const [w] = changeWindows("weekly", "2026-08-10");
    expect(w).toEqual({
      current: { from: "2026-08-03", to: "2026-08-09" },
      previous: { from: "2026-07-27", to: "2026-08-02" },
      periodKey: isoWeekKey("2026-08-09"),
    });
  });

  it("keys mid-week slides to the same ISO week so one week fires once", () => {
    // Tuesday and Friday of the same week: the sliding window differs but
    // the period key does not.
    const tue = changeWindows("weekly", "2026-08-11")[0]!;
    const fri = changeWindows("weekly", "2026-08-14")[0]!;
    expect(tue.current).not.toEqual(fri.current);
    expect(tue.periodKey).toBe(fri.periodKey);
  });
});

describe("changeWindows — monthly", () => {
  it("compares MTD complete days to the same number of days last month", () => {
    const [w] = changeWindows("monthly", "2026-08-10");
    expect(w).toEqual({
      current: { from: "2026-08-01", to: "2026-08-09" }, // 9 complete days
      previous: { from: "2026-07-01", to: "2026-07-09" }, // the same 9, never all 31
      periodKey: "2026-08",
    });
  });

  it("clamps the prior window to the prior month's length", () => {
    // 30 complete March days vs all 28 of February — day 30 does not exist.
    const [w] = changeWindows("monthly", "2026-03-31");
    expect(w!.current).toEqual({ from: "2026-03-01", to: "2026-03-30" });
    expect(w!.previous).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });

  it("has no window on the 1st — no complete day exists in the month yet", () => {
    expect(changeWindows("monthly", "2026-08-01")).toEqual([]);
  });

  it("crosses the year boundary", () => {
    const [w] = changeWindows("monthly", "2026-01-05");
    expect(w!.previous).toEqual({ from: "2025-12-01", to: "2025-12-04" });
    expect(w!.periodKey).toBe("2026-01");
  });
});

describe("isoWeekKey", () => {
  it("carries the ISO year, not the calendar year, at year boundaries", () => {
    // 2027-01-01 is a Friday of ISO week 2026-W53.
    expect(isoWeekKey("2027-01-01")).toBe("2026-W53");
    // 2024-12-30 is the Monday of ISO week 2025-W01.
    expect(isoWeekKey("2024-12-30")).toBe("2025-W01");
    expect(isoWeekKey("2026-08-09")).toBe("2026-W32");
  });
});

describe("windowTotals", () => {
  const current = { from: "2026-08-03", to: "2026-08-09" };
  const previous = { from: "2026-07-27", to: "2026-08-02" };

  it("sums each group's points inside each window and ignores the rest", () => {
    const groups: ChangeSeriesGroup[] = [
      {
        key: "aws",
        currency: "USD",
        points: [
          { bucket: "2026-07-20", amount: 999 }, // before both windows
          { bucket: "2026-07-27", amount: 10 },
          { bucket: "2026-08-02", amount: 5 },
          { bucket: "2026-08-03", amount: 20 },
          { bucket: "2026-08-09", amount: 30 },
          { bucket: "2026-08-10", amount: 999 }, // after both windows
        ],
      },
    ];
    expect(windowTotals(groups, current, previous)).toEqual([
      { key: "aws", currency: "USD", previousAmount: 15, currentAmount: 50 },
    ]);
  });

  it("keeps currencies apart even under the same key", () => {
    const groups: ChangeSeriesGroup[] = [
      { key: "aws", currency: "USD", points: [{ bucket: "2026-08-05", amount: 10 }] },
      { key: "aws", currency: "EUR", points: [{ bucket: "2026-08-05", amount: 7 }] },
    ];
    const out = windowTotals(groups, current, previous);
    expect(out).toHaveLength(2);
    expect(out.map((t) => t.currency).sort()).toEqual(["EUR", "USD"]);
  });

  it("folds two input groups sharing (key, currency) into one", () => {
    const groups: ChangeSeriesGroup[] = [
      { key: "aws", currency: "USD", points: [{ bucket: "2026-08-05", amount: 10 }] },
      { key: "aws", currency: "USD", points: [{ bucket: "2026-07-28", amount: 4 }] },
    ];
    expect(windowTotals(groups, current, previous)).toEqual([
      { key: "aws", currency: "USD", previousAmount: 4, currentAmount: 10 },
    ]);
  });

  it("drops groups with no spend in either window", () => {
    const groups: ChangeSeriesGroup[] = [
      { key: "gcp", currency: "USD", points: [{ bucket: "2026-06-01", amount: 100 }] },
    ];
    expect(windowTotals(groups, current, previous)).toEqual([]);
  });
});

describe("detectChanges — thresholds", () => {
  it("percent-only: fires at or past the bar, in either direction under 'both'", () => {
    const config = { ...BOTH, thresholdPercent: 50 };
    expect(detectChanges([totals(100, 150)], config)).toHaveLength(1); // exactly +50%
    expect(detectChanges([totals(100, 149)], config)).toHaveLength(0); // +49%
    expect(detectChanges([totals(100, 50)], config)).toHaveLength(1); // -50%
    expect(detectChanges([totals(100, 51)], config)).toHaveLength(0); // -49%
  });

  it("absolute-only: fires when the move reaches the cent floor", () => {
    const config = { ...BOTH, thresholdAmountCents: 5000 };
    expect(detectChanges([totals(100, 150)], config)).toHaveLength(1); // $50 move
    expect(detectChanges([totals(100, 149.99)], config)).toHaveLength(0); // $49.99
    expect(detectChanges([totals(100, 50)], config)).toHaveLength(1); // -$50
  });

  it("both thresholds set: BOTH must hold — a 50% jump on $2 stays quiet", () => {
    const config = { ...BOTH, thresholdPercent: 50, thresholdAmountCents: 5000 };
    // +50% but only a $1 move: percent passes, floor fails.
    expect(detectChanges([totals(2, 3)], config)).toHaveLength(0);
    // $60 move but only +6%: floor passes, percent fails.
    expect(detectChanges([totals(1000, 1060)], config)).toHaveLength(0);
    // +50% and a $50 move: both hold.
    expect(detectChanges([totals(100, 150)], config)).toHaveLength(1);
  });

  it("direction filters which sign of movement counts", () => {
    const up = { thresholdPercent: 10, thresholdAmountCents: null, direction: "increase" as const };
    const down = { ...up, direction: "decrease" as const };
    expect(detectChanges([totals(100, 200)], up)).toHaveLength(1);
    expect(detectChanges([totals(100, 50)], up)).toHaveLength(0);
    expect(detectChanges([totals(100, 50)], down)).toHaveLength(1);
    expect(detectChanges([totals(100, 200)], down)).toHaveLength(0);
  });

  it("reports rounded cents, a rounded signed percent, and the direction", () => {
    const [f] = detectChanges([totals(100, 273.456, "aws")], { ...BOTH, thresholdPercent: 100 });
    expect(f).toEqual({
      groupKey: "aws",
      currency: "USD",
      previousAmountCents: 10000,
      currentAmountCents: 27346,
      changePercent: 173,
      direction: "increase",
    });
  });

  it("skips moves that round to zero cents", () => {
    expect(detectChanges([totals(10, 10.001)], BOTH)).toHaveLength(0);
    expect(detectChanges([totals(0, 0)], BOTH)).toHaveLength(0);
  });
});

describe("detectChanges — new and vanished groups", () => {
  it("new spend: null percent, satisfies any percent threshold", () => {
    const config = {
      thresholdPercent: 500,
      thresholdAmountCents: null,
      direction: "both" as const,
    };
    const [f] = detectChanges([totals(0, 42, "new-service")], config);
    expect(f).toMatchObject({
      groupKey: "new-service",
      previousAmountCents: 0,
      currentAmountCents: 4200,
      changePercent: null,
      direction: "increase",
    });
  });

  it("new spend still respects an absolute floor — a $0.30 new group is not a page", () => {
    const config = { thresholdPercent: 50, thresholdAmountCents: 5000, direction: "both" as const };
    expect(detectChanges([totals(0, 0.3)], config)).toHaveLength(0);
    expect(detectChanges([totals(0, 51)], config)).toHaveLength(1);
  });

  it("a vanished group is a -100% decrease of its whole prior spend", () => {
    const config = {
      thresholdPercent: 50,
      thresholdAmountCents: null,
      direction: "decrease" as const,
    };
    const [f] = detectChanges([totals(80, 0, "gone-service")], config);
    expect(f).toMatchObject({
      groupKey: "gone-service",
      previousAmountCents: 8000,
      currentAmountCents: 0,
      changePercent: -100,
      direction: "decrease",
    });
  });

  it("a vanished group is invisible to an increase-only alert", () => {
    const config = {
      thresholdPercent: 10,
      thresholdAmountCents: null,
      direction: "increase" as const,
    };
    expect(detectChanges([totals(80, 0)], config)).toHaveLength(0);
  });

  it("a refund-heavy (negative) prior window keeps the sign meaningful", () => {
    // -$50 → $100 is an increase of $150, +300% of the prior magnitude.
    const [f] = detectChanges([totals(-50, 100)], { ...BOTH, thresholdPercent: 100 });
    expect(f).toMatchObject({ changePercent: 300, direction: "increase" });
  });
});

describe("detectChanges — currencies", () => {
  it("compares each currency separately, never across", () => {
    const config = { thresholdPercent: 50, thresholdAmountCents: null, direction: "both" as const };
    const out = detectChanges(
      [totals(100, 200, "aws", "USD"), totals(100, 110, "aws", "EUR")],
      config,
    );
    // Only the USD series moved past the bar; EUR's +10% stays quiet.
    expect(out).toHaveLength(1);
    expect(out[0]!.currency).toBe("USD");
  });

  it("with a display currency, spend the org holds rates for compares converted", () => {
    const current = { from: "2026-08-09", to: "2026-08-09" };
    const previous = { from: "2026-08-02", to: "2026-08-02" };
    const raw: ChangeSeriesGroup[] = [
      { key: "", currency: "USD", points: [{ bucket: "2026-08-02", amount: 100 }] },
      { key: "", currency: "EUR", points: [{ bucket: "2026-08-09", amount: 200 }] },
    ];
    const { groups } = convertGroups(raw, "USD", [rate("EUR", "USD", "1.10")]);
    const out = detectChanges(windowTotals(groups, current, previous), {
      ...BOTH,
      thresholdPercent: 50,
    });
    // EUR spend converted at 1.10 lands in the same USD comparison.
    expect(out).toEqual([
      {
        groupKey: "",
        currency: "USD",
        previousAmountCents: 10000,
        currentAmountCents: 22000,
        changePercent: 120,
        direction: "increase",
      },
    ]);
  });

  it("a currency with no rate is compared in its own currency, never dropped", () => {
    const current = { from: "2026-08-09", to: "2026-08-09" };
    const previous = { from: "2026-08-02", to: "2026-08-02" };
    const raw: ChangeSeriesGroup[] = [
      {
        key: "",
        currency: "NOK",
        points: [
          { bucket: "2026-08-02", amount: 100 },
          { bucket: "2026-08-09", amount: 300 },
        ],
      },
    ];
    // Org display currency is USD but it stated no NOK rate.
    const { groups, conversion } = convertGroups(raw, "USD", []);
    expect(conversion?.unconverted).toEqual(["NOK"]);
    const out = detectChanges(windowTotals(groups, current, previous), {
      ...BOTH,
      thresholdPercent: 50,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ currency: "NOK", changePercent: 200 });
  });
});
