import { describe, expect, it } from "vitest";
import {
  budgetDepth,
  budgetDescendantIds,
  budgetInputError,
  budgetLimitForWindow,
  budgetProgress,
  budgetSubtreeHeight,
  budgetWithStatusToInput,
  buildBudgetTree,
  resolveBudgetPeriod,
  upcomingBudgetPeriod,
  type BudgetInput,
  type BudgetPeriod,
  type BudgetWithStatus,
} from "../index";

const base: BudgetInput = {
  name: "b",
  amountCents: 1000,
  currency: "USD",
  filters: [],
  thresholds: [{ type: "actual", percent: 100 }],
};

describe("resolveBudgetPeriod", () => {
  it("defaults to the calendar month, keyed YYYY-MM so old alert history still dedupes", () => {
    expect(resolveBudgetPeriod(null, "2026-02-14")).toEqual({
      start: "2026-02-01",
      end: "2026-02-28",
      key: "2026-02",
    });
  });

  it("walks a weekly cadence from its start date", () => {
    const period = {
      kind: "recurring",
      unit: "week",
      interval: 2,
      startDate: "2026-10-05",
    } as const;
    expect(resolveBudgetPeriod(period, "2026-10-05")).toMatchObject({
      start: "2026-10-05",
      end: "2026-10-18",
    });
    expect(resolveBudgetPeriod(period, "2026-10-19")).toMatchObject({
      start: "2026-10-19",
      end: "2026-11-01",
      key: "2026-10-19",
    });
  });

  it("returns null before a cadence starts and offers the first period as upcoming", () => {
    const period = {
      kind: "recurring",
      unit: "day",
      interval: 1,
      startDate: "2026-10-10",
    } as const;
    expect(resolveBudgetPeriod(period, "2026-10-04")).toBeNull();
    expect(upcomingBudgetPeriod(period, "2026-10-04")).toMatchObject({ start: "2026-10-10" });
  });

  it("clamps month-based cadences to the month end without drifting", () => {
    const period = {
      kind: "recurring",
      unit: "month",
      interval: 1,
      startDate: "2026-01-31",
    } as const;
    expect(resolveBudgetPeriod(period, "2026-02-28")).toMatchObject({
      start: "2026-02-28",
      end: "2026-03-30",
    });
    expect(resolveBudgetPeriod(period, "2026-03-31")).toMatchObject({ start: "2026-03-31" });
  });

  it("resolves quarters and years with a mid-month start", () => {
    const quarter = {
      kind: "recurring",
      unit: "quarter",
      interval: 1,
      startDate: "2026-01-15",
    } as const;
    expect(resolveBudgetPeriod(quarter, "2026-04-14")).toMatchObject({
      start: "2026-01-15",
      end: "2026-04-14",
    });
    expect(resolveBudgetPeriod(quarter, "2026-04-15")).toMatchObject({ start: "2026-04-15" });
    const year = { kind: "recurring", unit: "year", interval: 1, startDate: "2025-07-01" } as const;
    expect(resolveBudgetPeriod(year, "2026-10-04")).toMatchObject({
      start: "2026-07-01",
      end: "2027-06-30",
    });
  });

  it("finds the explicit entry covering today, with its own amount", () => {
    const period = {
      kind: "explicit",
      periods: [
        { start: "2026-10-01", end: "2026-10-15", amountCents: 500 },
        { start: "2026-10-20", end: "2026-10-31", amountCents: 900 },
      ],
    } satisfies BudgetPeriod;
    const window = resolveBudgetPeriod(period, "2026-10-21")!;
    expect(window).toMatchObject({ start: "2026-10-20", amountCents: 900 });
    expect(budgetLimitForWindow({ amountCents: 1 }, window)).toBe(900);
    expect(resolveBudgetPeriod(period, "2026-10-17")).toBeNull();
    expect(upcomingBudgetPeriod(period, "2026-10-17")).toMatchObject({ start: "2026-10-20" });
  });
});

describe("budgetInputError", () => {
  it("accepts a plain monthly spend budget", () => {
    expect(budgetInputError(base)).toBeNull();
  });

  it("requires a unit and amount for a usage budget, and refuses spend-only options", () => {
    expect(budgetInputError({ ...base, measure: "usage" })).toMatch(/usage unit/);
    expect(budgetInputError({ ...base, measure: "usage", usageUnit: "tokens" })).toMatch(
      /usage amount/,
    );
    expect(
      budgetInputError({
        ...base,
        measure: "usage",
        usageUnit: "tokens",
        usageAmount: 1e6,
        scenarioModelId: "m",
      }),
    ).toMatch(/Scenario/);
    expect(
      budgetInputError({ ...base, measure: "usage", usageUnit: "tokens", usageAmount: 1e6 }),
    ).toBeNull();
  });

  it("refuses overlapping explicit periods and periods without an amount", () => {
    const err = budgetInputError({
      ...base,
      amountCents: 0,
      period: {
        kind: "explicit",
        periods: [
          { start: "2026-10-01", end: "2026-10-15", amountCents: 1 },
          { start: "2026-10-15", end: "2026-10-31", amountCents: 1 },
        ],
      },
    });
    expect(err).toMatch(/overlap/);
    expect(
      budgetInputError({
        ...base,
        amountCents: 0,
        period: { kind: "explicit", periods: [{ start: "2026-10-01", end: "2026-10-15" }] },
      }),
    ).toMatch(/amount/);
  });

  it("refuses an invalid recurring start date", () => {
    expect(
      budgetInputError({
        ...base,
        period: { kind: "recurring", unit: "week", interval: 1, startDate: "2026-02-30" },
      }),
    ).toMatch(/start date/);
  });
});

describe("hierarchy helpers", () => {
  const list = [
    { id: "root", name: "Root" },
    { id: "a", name: "A", parentBudgetId: "root" },
    { id: "b", name: "B", parentBudgetId: "a" },
    { id: "orphan", name: "Orphan", parentBudgetId: "gone" },
  ];

  it("builds trees and keeps a budget whose parent is missing as a root", () => {
    const trees = buildBudgetTree(list);
    expect(trees.map((t) => t.budget.id)).toEqual(["root", "orphan"]);
    expect(trees[0]!.children[0]!.children[0]!.budget.id).toBe("b");
    expect(trees[0]!.children[0]!.children[0]!.depth).toBe(2);
  });

  it("does not loop on a cycle", () => {
    const trees = buildBudgetTree([
      { id: "x", name: "X", parentBudgetId: "y" },
      { id: "y", name: "Y", parentBudgetId: "x" },
    ]);
    expect(trees.length).toBeGreaterThan(0);
  });

  it("measures depth, height and descendants", () => {
    expect(budgetDepth(list, "b")).toBe(3);
    expect(budgetSubtreeHeight(list, "root")).toBe(3);
    expect([...budgetDescendantIds(list, "root")].sort()).toEqual(["a", "b"]);
  });
});

describe("budgetProgress", () => {
  const row: BudgetWithStatus = {
    id: "b",
    name: "b",
    amountCents: 100_00,
    currency: "USD",
    filters: [],
    thresholds: [],
    month: "2026-10",
    actualCents: 50_00,
    forecastCents: 120_00,
    currentMonthEvents: [],
    placements: [],
  };

  it("reads an old server's row as a monthly spend budget", () => {
    expect(budgetProgress(row)).toMatchObject({
      measure: "cost",
      limit: 100,
      actual: 50,
      forecast: 120,
      actualPercent: 50,
      active: true,
    });
  });

  it("reads a usage budget's quantities", () => {
    const usage = budgetProgress({
      ...row,
      measure: "usage",
      usageUnit: "tokens",
      usageAmount: 1000,
      periodLimit: 1000,
      periodStart: "2026-10-01",
      actualUsage: 250,
      forecastUsage: 900,
    });
    expect(usage).toMatchObject({ measure: "usage", limit: 1000, actual: 250, forecast: 900 });
    expect(usage.actualPercent).toBe(25);
  });

  it("round-trips every field through the editor input", () => {
    const input = budgetWithStatusToInput({
      ...row,
      measure: "usage",
      usageUnit: "GB",
      usageAmount: 5,
      parentBudgetId: "p",
      period: { kind: "recurring", unit: "week", interval: 1, startDate: "2026-10-05" },
    });
    expect(input).toMatchObject({
      measure: "usage",
      usageUnit: "GB",
      usageAmount: 5,
      parentBudgetId: "p",
      period: { kind: "recurring" },
    });
  });
});
