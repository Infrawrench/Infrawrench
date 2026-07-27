import { describe, expect, it } from "vitest";
import type { CostQueryResponse, CostQuerySeries } from "../config.js";
import {
  alignComparison,
  COMPARISON_KEY,
  FORECAST_KEY,
  pivotSeries,
  spliceForecast,
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

// binForecast, totalPerBucket, and the label/money formatters moved to
// client-core (mobile shares them) — see client-core/src/__tests__/costs.test.ts.
