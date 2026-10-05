/**
 * The calculation modes beyond plain unit cost (scale, gross margin with its
 * absolute margin, raw metric, per-usage-unit cost) and the labelled-row sum,
 * against the pure layer. The threshold judge is pure too and is pinned here
 * for the same reason: a coverage rule that slipped would page about a window
 * of gaps.
 */
import { describe, it, expect, vi } from "vitest";

// The threshold module imports the db client at module scope; nothing here
// opens a connection.
process.env["DATABASE_URL"] ??= "postgres://test:test@localhost:5432/test";
vi.mock("../db/client", () => ({ db: {} }));

import type { UnitCostQueryResponse } from "@infrawrench/client-core";
import { computeUnitCosts, type UnitCostComputeInput } from "../cost/unit-costs";

const { judgeUnitCostThreshold, unitCostThresholdKey } =
  await import("../cost/unit-cost-threshold-eval");

function input(overrides: Partial<UnitCostComputeInput> = {}): UnitCostComputeInput {
  return {
    from: "2026-07-01",
    to: "2026-07-03",
    binning: "daily",
    mode: "unit_cost",
    costGroups: [
      {
        currency: "USD",
        points: [
          { bucket: "2026-07-01", amount: 100 },
          { bucket: "2026-07-02", amount: 200 },
          { bucket: "2026-07-03", amount: 300 },
        ],
      },
    ],
    values: [
      { day: "2026-07-01", value: 10 },
      { day: "2026-07-02", value: 20 },
      { day: "2026-07-03", value: 30 },
    ],
    metricCurrency: null,
    ...overrides,
  };
}

describe("calculations beyond unit cost", () => {
  it("scales a unit cost on the quotient only", () => {
    const s = computeUnitCosts(input({ scale: 1000 })).series[0]!;
    expect(s.points[0]!.value).toBe(10_000);
    expect(s.points[0]!.cost).toBe(100);
    expect(s.points[0]!.metricValue).toBe(10);
    expect(s.overallValue).toBe(10_000);
  });

  it("reports the absolute margin beside the fraction, and ignores scale", () => {
    const s = computeUnitCosts(
      input({
        mode: "margin",
        metricCurrency: "USD",
        scale: 1000,
        values: [
          { day: "2026-07-01", value: 400 },
          { day: "2026-07-02", value: 400 },
          { day: "2026-07-03", value: 400 },
        ],
      }),
    ).series[0]!;
    expect(s.points[0]!.value).toBe(0.75);
    expect(s.points[0]!.absoluteMargin).toBe(300);
    expect(s.overallAbsoluteMargin).toBe(600);
    expect(s.overallValue).toBe(0.5);
  });

  it("plots the raw metric, zero and negative included, divided by the scale", () => {
    const { series, gapBuckets } = computeUnitCosts(
      input({
        mode: "raw_metric",
        scale: 10,
        values: [
          { day: "2026-07-01", value: 0 },
          { day: "2026-07-02", value: -20 },
        ],
      }),
    );
    const points = series[0]!.points;
    expect(points[0]!.value).toBe(0);
    expect(points[1]!.value).toBe(-2);
    // An unreported day is still a gap: raw mode only stops treating zero as one.
    expect(points[2]!.value).toBeNull();
    expect(points[2]!.gap).toBe("no_metric_value");
    expect(gapBuckets).toBe(1);
  });

  it("names a missing or zero usage quantity as no_usage", () => {
    const points = computeUnitCosts(
      input({
        mode: "usage_unit_cost",
        values: [
          { day: "2026-07-01", value: 50 },
          { day: "2026-07-02", value: 0 },
        ],
      }),
    ).series[0]!.points;
    expect(points[0]!.value).toBe(2);
    expect(points[1]!.gap).toBe("no_usage");
    expect(points[2]!.gap).toBe("no_usage");
  });

  it("sums several labelled rows for one day rather than keeping the last", () => {
    const point = computeUnitCosts(
      input({
        values: [
          { day: "2026-07-01", value: 4 },
          { day: "2026-07-01", value: 6 },
        ],
      }),
    ).series[0]!.points[0]!;
    expect(point.metricValue).toBe(10);
    expect(point.value).toBe(10);
  });
});

function response(
  series: Array<{ value: number | null; reported: number; label?: string; other?: boolean }>,
): UnitCostQueryResponse {
  return {
    metric: { id: "m", key: "m", name: "M", unit: "customer", kind: "currency", currency: "USD" },
    mode: "margin",
    binning: "daily",
    scale: 1,
    gapBuckets: 0,
    partialBuckets: 0,
    series: series.map((s) => ({
      currency: "USD",
      ...(s.label !== undefined || s.other
        ? {
            label: { key: "customer", value: s.label ?? null, ...(s.other ? { other: true } : {}) },
          }
        : {}),
      points: Array.from({ length: s.reported }, (_, i) => ({
        bucket: `2026-07-0${i + 1}`,
        value: 0.1,
        cost: 10,
        metricValue: 100,
        reportedDays: 1,
        bucketDays: 1,
      })),
      overallValue: s.value,
      overallCost: 70,
      overallMetricValue: 100,
    })),
  };
}

describe("judgeUnitCostThreshold", () => {
  const margin = { mode: "margin" as const, direction: "below" as const, value: 30 };

  it("compares margin as a percentage", () => {
    const breaches = judgeUnitCostThreshold(margin, response([{ value: 0.25, reported: 7 }]), 7);
    expect(breaches).toHaveLength(1);
    expect(breaches[0]!.observed).toBe(25);
  });

  it("does not judge a window with fewer than half its days reported", () => {
    expect(judgeUnitCostThreshold(margin, response([{ value: 0.1, reported: 3 }]), 7)).toEqual([]);
  });

  it("skips a null period value and the Other fold", () => {
    const breaches = judgeUnitCostThreshold(
      margin,
      response([
        { value: null, reported: 7, label: "acme" },
        { value: 0.1, reported: 7, other: true },
        { value: 0.2, reported: 7, label: "globex" },
      ]),
      7,
    );
    expect(breaches.map((b) => b.labelValue)).toEqual(["globex"]);
  });

  it("keys a threshold by its own fields, so an edit is a new threshold", () => {
    expect(unitCostThresholdKey(margin)).toBe(unitCostThresholdKey({ ...margin, windowDays: 7 }));
    expect(unitCostThresholdKey(margin)).not.toBe(unitCostThresholdKey({ ...margin, value: 31 }));
  });
});
