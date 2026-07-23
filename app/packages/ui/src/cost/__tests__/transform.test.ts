import { describe, expect, it } from "vitest";
import type { CostQueryResponse, CostQuerySeries } from "../config.js";
import {
  alignComparison,
  binForecast,
  COMPARISON_KEY,
  FORECAST_KEY,
  formatBucketLabel,
  pivotSeries,
  spliceForecast,
  totalPerBucket,
} from "../transform.js";

const series = (
  key: string,
  points: Array<[string, number]>,
  currency = "USD",
): CostQuerySeries => ({
  key,
  label: key,
  currency,
  points: points.map(([bucket, amount]) => ({ bucket, amount })),
});

describe("pivotSeries", () => {
  it("pivots groups into bucket rows with stable dataKeys", () => {
    const { rows, series: defs } = pivotSeries([
      series("aws", [
        ["2026-07-01", 10],
        ["2026-07-02", 12],
      ]),
      series("gcp", [["2026-07-02", 5]]),
    ]);
    expect(defs.map((d) => d.dataKey)).toEqual(["s0", "s1"]);
    expect(rows).toEqual([
      { bucket: "2026-07-01", s0: 10 },
      { bucket: "2026-07-02", s0: 12, s1: 5 },
    ]);
  });

  it("marks the folded Other series and disambiguates mixed currencies", () => {
    const { series: defs } = pivotSeries([
      series("aws", [["2026-07-01", 1]], "USD"),
      series("__other__", [["2026-07-01", 2]], "EUR"),
    ]);
    expect(defs[0]!.label).toBe("aws (USD)");
    expect(defs[1]!.isOther).toBe(true);
  });
});

describe("alignComparison", () => {
  it("overlays previous-period totals positionally", () => {
    const { rows } = pivotSeries([
      series("a", [
        ["2026-07-01", 10],
        ["2026-07-02", 12],
        ["2026-07-03", 14],
      ]),
    ]);
    alignComparison(rows, [
      series("a", [
        ["2026-06-01", 7],
        ["2026-06-02", 8],
      ]),
    ]);
    expect(rows.map((r) => r[COMPARISON_KEY])).toEqual([7, 8, null]);
  });
});

describe("binForecast", () => {
  const daily = [
    { bucket: "2026-07-30", amount: 2 },
    { bucket: "2026-07-31", amount: 3 },
    { bucket: "2026-08-01", amount: 4 },
  ];

  it("passes daily through unchanged", () => {
    expect(binForecast(daily, "daily")).toEqual(daily);
  });

  it("bins monthly onto month starts", () => {
    expect(binForecast(daily, "monthly")).toEqual([
      { bucket: "2026-07-01", amount: 5 },
      { bucket: "2026-08-01", amount: 4 },
    ]);
  });

  it("bins weekly onto Mondays", () => {
    // Thu 2026-07-30, Fri 07-31, and Sat 08-01 all fall in the week of Mon 07-27.
    expect(binForecast(daily, "weekly")).toEqual([{ bucket: "2026-07-27", amount: 9 }]);
  });

  it("accumulates for cumulative starting from the last actual", () => {
    expect(binForecast(daily, "cumulative", 100)).toEqual([
      { bucket: "2026-07-30", amount: 102 },
      { bucket: "2026-07-31", amount: 105 },
      { bucket: "2026-08-01", amount: 109 },
    ]);
  });
});

describe("spliceForecast", () => {
  it("appends forecast rows and anchors the connecting point", () => {
    const response: CostQueryResponse = {
      series: [
        series("a", [
          ["2026-07-01", 10],
          ["2026-07-02", 12],
        ]),
      ],
      forecast: [
        { bucket: "2026-07-03", amount: 13 },
        { bucket: "2026-07-04", amount: 14 },
      ],
      currencies: ["USD"],
      totals: { USD: 22 },
    };
    const pivot = pivotSeries(response.series);
    spliceForecast(pivot, response, "daily");
    expect(pivot.rows).toHaveLength(4);
    // Anchor on the last observed bucket so the dashed line connects.
    expect(pivot.rows[1]![FORECAST_KEY]).toBe(12);
    expect(pivot.rows[3]).toEqual({ bucket: "2026-07-04", [FORECAST_KEY]: 14 });
  });
});

describe("totalPerBucket", () => {
  it("sums across series per bucket in order", () => {
    expect(
      totalPerBucket([
        series("a", [["2026-07-02", 1]]),
        series("b", [
          ["2026-07-01", 2],
          ["2026-07-02", 3],
        ]),
      ]),
    ).toEqual([
      { bucket: "2026-07-01", amount: 2 },
      { bucket: "2026-07-02", amount: 4 },
    ]);
  });
});

describe("formatBucketLabel", () => {
  it("formats month bins as month + year", () => {
    expect(formatBucketLabel("2026-07-01", "monthly")).toMatch(/Jul/);
    expect(formatBucketLabel("2026-07-01", "monthly")).toMatch(/2026/);
  });
  it("falls back to the raw bucket for malformed input", () => {
    expect(formatBucketLabel("garbage", "daily")).toBe("garbage");
  });
});
