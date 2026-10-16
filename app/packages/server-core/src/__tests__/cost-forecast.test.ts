import { describe, expect, it } from "vitest";
import {
  fitTrend,
  forecastDaily,
  forecastDailyWithBounds,
  forecastMonthTotal,
  forecastWeightedSum,
  forecastWindowRange,
  forecastWindowTotal,
  isForecastConfidenceLevel,
  tQuantile,
  type DailyPoint,
} from "../cost/forecast";

function days(start: string, amounts: number[]): DailyPoint[] {
  const d = new Date(`${start}T00:00:00.000Z`);
  return amounts.map((amount, i) => {
    const day = new Date(d);
    day.setUTCDate(day.getUTCDate() + i);
    return { day: day.toISOString().slice(0, 10), amount };
  });
}

describe("forecastDaily", () => {
  it("returns [] with fewer than 7 points", () => {
    expect(forecastDaily(days("2026-07-01", [1, 2, 3, 4, 5, 6]), 5)).toEqual([]);
  });

  it("projects a flat series flat", () => {
    const projected = forecastDaily(days("2026-07-01", Array(10).fill(5)), 3);
    expect(projected).toHaveLength(3);
    expect(projected[0]).toEqual({ day: "2026-07-11", amount: expect.closeTo(5, 6) });
    expect(projected[2]!.day).toBe("2026-07-13");
  });

  it("continues a linear trend", () => {
    const projected = forecastDaily(days("2026-07-01", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 2);
    expect(projected[0]!.amount).toBeCloseTo(11, 6);
    expect(projected[1]!.amount).toBeCloseTo(12, 6);
  });

  it("clamps a declining trend at zero", () => {
    const projected = forecastDaily(days("2026-07-01", [8, 7, 6, 5, 4, 3, 2, 1]), 5);
    expect(projected.every((p) => p.amount >= 0)).toBe(true);
    expect(projected[4]!.amount).toBe(0);
  });

  it("crosses month boundaries with correct dates", () => {
    // Last observed day is 2026-07-31, so the first projection lands on Aug 1.
    const projected = forecastDaily(days("2026-07-25", Array(7).fill(2)), 8);
    expect(projected[0]!.day).toBe("2026-08-01");
    expect(projected[7]!.day).toBe("2026-08-08");
  });
});

describe("forecastMonthTotal", () => {
  it("returns null when the month has no data", () => {
    expect(forecastMonthTotal(days("2026-06-01", Array(10).fill(3)), "2026-07")).toBeNull();
  });

  it("returns MTD when the month is complete", () => {
    const points = days("2026-06-01", Array(30).fill(2));
    expect(forecastMonthTotal(points, "2026-06")).toBeCloseTo(60, 6);
  });

  it("projects a flat partial month to a full-month total", () => {
    // 15 days at $10/day observed of July (31 days) → ~$310 projected.
    const points = days("2026-07-01", Array(15).fill(10));
    expect(forecastMonthTotal(points, "2026-07")).toBeCloseTo(310, 3);
  });

  it("falls back to a daily average with too little history for a fit", () => {
    const points = days("2026-07-01", [10, 10, 10]);
    // 30 + 10 × 28 remaining days
    expect(forecastMonthTotal(points, "2026-07")).toBeCloseTo(310, 6);
  });
});

// Reference values below come from the matrix form of the OLS prediction
// interval, var = s^2 * (1 + x0' (X'X)^-1 x0), computed independently of the
// closed form `forecast.ts` uses.
const NOISY = [10, 12, 9, 14, 13, 15, 12, 16, 18, 15];

describe("tQuantile", () => {
  it("reads the tabulated two-sided quantiles", () => {
    expect(tQuantile(95, 5)).toBe(2.571);
    expect(tQuantile(80, 8)).toBe(1.397);
    expect(tQuantile(90, 28)).toBe(1.701);
  });

  it("falls back to the normal quantile past 30 degrees of freedom", () => {
    expect(tQuantile(95, 40)).toBe(1.96);
    expect(tQuantile(80, 120)).toBe(1.2816);
  });

  it("is infinite with no degrees of freedom", () => {
    expect(tQuantile(80, 0)).toBe(Number.POSITIVE_INFINITY);
  });

  it("only accepts the supported levels", () => {
    expect(isForecastConfidenceLevel(80)).toBe(true);
    expect(isForecastConfidenceLevel(99)).toBe(false);
    expect(isForecastConfidenceLevel("80")).toBe(false);
  });
});

describe("forecastDailyWithBounds", () => {
  it("keeps the point forecast forecastDaily draws", () => {
    const points = days("2026-07-01", NOISY);
    const plain = forecastDaily(points, 5);
    const bounded = forecastDailyWithBounds(points, 5);
    expect(bounded.map((p) => ({ day: p.day, amount: p.amount }))).toEqual(plain);
  });

  it("matches the textbook prediction interval at 80% and 95%", () => {
    const points = days("2026-07-01", NOISY);
    const at80 = forecastDailyWithBounds(points, 5, 80);
    expect(at80[0]!.amount).toBeCloseTo(17.333333, 5);
    expect(at80[0]!.low).toBeCloseTo(14.271243, 5);
    expect(at80[0]!.high).toBeCloseTo(20.395424, 5);
    expect(at80[4]!.low).toBeCloseTo(16.448829, 5);
    expect(at80[4]!.high).toBeCloseTo(23.93905, 5);
    const at95 = forecastDailyWithBounds(points, 1, 95);
    expect(at95[0]!.low).toBeCloseTo(12.278802, 5);
    expect(at95[0]!.high).toBeCloseTo(22.387865, 5);
  });

  it("fans out the further ahead it projects", () => {
    const bounded = forecastDailyWithBounds(days("2026-07-01", NOISY), 20);
    const widths = bounded.map((p) => p.high - p.low);
    for (let i = 1; i < widths.length; i++) expect(widths[i]!).toBeGreaterThan(widths[i - 1]!);
  });

  it("collapses to the line when the history is exactly linear", () => {
    const bounded = forecastDailyWithBounds(days("2026-07-01", [1, 2, 3, 4, 5, 6, 7, 8]), 3);
    for (const p of bounded) {
      expect(p.low).toBeCloseTo(p.amount, 9);
      expect(p.high).toBeCloseTo(p.amount, 9);
    }
  });

  it("clamps the lower bound at zero", () => {
    const bounded = forecastDailyWithBounds(days("2026-07-01", [9, 3, 8, 2, 6, 1, 4, 0]), 10);
    expect(bounded.every((p) => p.low >= 0 && p.amount >= 0)).toBe(true);
    expect(bounded.some((p) => p.low === 0)).toBe(true);
  });

  it("returns [] when there is no fit", () => {
    expect(forecastDailyWithBounds(days("2026-07-01", [1, 2, 3]), 5)).toEqual([]);
  });
});

describe("forecastWeightedSum", () => {
  it("gives a total's interval from one fit, narrower than summed daily bounds", () => {
    const points = days("2026-07-01", NOISY);
    const f = fitTrend(points)!;
    const total = forecastWeightedSum(
      f,
      [1, 2, 3].map((offset) => ({ offset, weight: 1 })),
    );
    expect(total.expected).toBeCloseTo(54.145455, 5);
    expect(total.halfWidth).toBeCloseTo(7.375541, 5);
    const daily = forecastDailyWithBounds(points, 3);
    const summedHalfWidths = daily.reduce((s, p) => s + (p.high - p.low) / 2, 0);
    expect(total.halfWidth).toBeLessThan(summedHalfWidths);
  });

  it("weights each day, for a unit cost times forecast volume", () => {
    const f = fitTrend(days("2026-07-01", NOISY))!;
    const weighted = forecastWeightedSum(f, [
      { offset: 1, weight: 2 },
      { offset: 2, weight: 0.5 },
      { offset: 3, weight: 1 },
    ]);
    expect(weighted.expected).toBeCloseTo(62.454545, 5);
    expect(weighted.halfWidth).toBeCloseTo(8.834744, 5);
  });
});

describe("forecastWindowRange", () => {
  it("keeps forecastWindowTotal's expected value and brackets it", () => {
    const points = days("2026-07-01", [...NOISY, 14, 17, 16, 19, 18]);
    const range = forecastWindowRange(points, "2026-07-01", "2026-07-31")!;
    expect(range.expected).toBeCloseTo(forecastWindowTotal(points, "2026-07-01", "2026-07-31")!, 9);
    expect(range.low!).toBeLessThan(range.expected);
    expect(range.high!).toBeGreaterThan(range.expected);
  });

  it("never puts the low below what has already been spent", () => {
    const points = days("2026-07-01", [50, 0, 60, 1, 70, 0, 40, 2, 55, 0]);
    const range = forecastWindowRange(points, "2026-07-01", "2026-07-31")!;
    const spent = points.reduce((s, p) => s + p.amount, 0);
    expect(range.low!).toBeGreaterThanOrEqual(spent);
  });

  it("is exact once the window is over", () => {
    const points = days("2026-06-01", Array(30).fill(2));
    expect(forecastWindowRange(points, "2026-06-01", "2026-06-30")).toEqual({
      expected: 60,
      low: 60,
      high: 60,
    });
  });

  it("has no bounds on the daily-average fallback", () => {
    const range = forecastWindowRange(days("2026-07-01", [10, 10, 10]), "2026-07-01", "2026-07-31");
    expect(range).toEqual({ expected: expect.closeTo(310, 6), low: null, high: null });
  });

  it("is null when the window has no data", () => {
    expect(
      forecastWindowRange(days("2026-06-01", [1, 2, 3, 4, 5, 6, 7]), "2026-07-01", "2026-07-31"),
    ).toBeNull();
  });
});
