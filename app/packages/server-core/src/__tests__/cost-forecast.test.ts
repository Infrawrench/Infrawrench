import { describe, expect, it } from "vitest";
import { forecastDaily, forecastMonthTotal, type DailyPoint } from "../cost/forecast";

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
