import { describe, expect, it } from "vitest";
import type { UnitCostQueryResponse } from "../business-metrics";
import {
  UNIT_COST_EXPORT_COLUMNS,
  reportUnitCostLookup,
  unitCostCsvCell,
  unitCostExportFile,
  unitCostExportFilename,
  unitCostExportRows,
} from "../unit-cost-export";

const response: UnitCostQueryResponse = {
  metric: {
    id: "m1",
    key: "active_users",
    name: "Active users",
    unit: "user",
    kind: "count",
    currency: null,
  },
  mode: "unit_cost",
  binning: "daily",
  scale: 1000,
  groupByLabel: "customer",
  costPerLabel: true,
  gapBuckets: 1,
  partialBuckets: 1,
  series: [
    {
      currency: "USD",
      label: { key: "customer", value: "=acme" },
      overallValue: 2,
      overallCost: 30,
      overallMetricValue: 15000,
      points: [
        // Out of order on purpose: the export sorts by bucket.
        {
          bucket: "2026-10-02",
          value: null,
          cost: 10,
          metricValue: null,
          gap: "no_metric_value",
          reportedDays: 0,
          bucketDays: 1,
        },
        {
          bucket: "2026-10-01",
          value: 2,
          cost: 20,
          metricValue: 10000,
          reportedDays: 1,
          bucketDays: 1,
        },
      ],
    },
    {
      currency: "USD",
      label: { key: "customer", value: null, other: true },
      overallValue: 1,
      overallCost: 5,
      overallMetricValue: 5000,
      points: [
        {
          bucket: "2026-10-01",
          value: 1,
          cost: 5,
          metricValue: 5000,
          reportedDays: 5,
          bucketDays: 7,
        },
      ],
    },
  ],
};

describe("unitCostExportRows", () => {
  it("writes one row per bucket per series, gaps empty rather than zero", () => {
    const rows = unitCostExportRows(response);
    expect(rows.map((r) => [r.bucket, r.label_value, r.value, r.gap])).toEqual([
      ["2026-10-01", "=acme", 2, null],
      ["2026-10-02", "=acme", null, "no_metric_value"],
      ["2026-10-01", null, 1, null],
    ]);
    expect(rows[2]).toMatchObject({
      label_other: true,
      partial: true,
      scale: 1000,
      metric_key: "active_users",
    });
  });

  it("serialises CSV with the header, blank gaps and guarded text", () => {
    const { body, extension, contentType } = unitCostExportFile(response, "csv");
    expect(extension).toBe("csv");
    expect(contentType).toMatch(/text\/csv/);
    const lines = body.trimEnd().split("\n");
    expect(lines[0]).toBe(UNIT_COST_EXPORT_COLUMNS.join(","));
    expect(lines[2]).toBe(
      "2026-10-02,1,0,false,customer,'=acme,false,USD,unit_cost,1000,active_users,user,,10,,,,no_metric_value",
    );
  });

  it("serialises NDJSON with nulls for gaps", () => {
    const { body } = unitCostExportFile(response, "ndjson");
    const second = JSON.parse(body.split("\n")[1]!);
    expect(second).toMatchObject({ bucket: "2026-10-02", value: null, metric_value: null });
  });
});

describe("helpers", () => {
  it("quotes and guards text but never numbers", () => {
    expect(unitCostCsvCell("a,b")).toBe('"a,b"');
    expect(unitCostCsvCell("@x")).toBe("'@x");
    expect(unitCostCsvCell(-0.25)).toBe("-0.25");
    expect(unitCostCsvCell(Number.NaN)).toBe("");
    expect(unitCostCsvCell(null)).toBe("");
  });

  it("names the file after the metric and range", () => {
    expect(
      unitCostExportFilename(response, { from: "2026-10-01", to: "2026-10-31" }, "ndjson"),
    ).toBe("unit-costs-active-users-2026-10-01-to-2026-10-31.ndjson");
    expect(
      unitCostExportFilename({ metric: null, usageUnit: "GB-Mo" }, { from: "a", to: "b" }, "csv"),
    ).toBe("unit-costs-gb-mo-a-to-b.csv");
  });

  it("indexes unlabelled daily series by day and currency for report exports", () => {
    const daily: UnitCostQueryResponse = {
      ...response,
      groupByLabel: undefined,
      series: [{ ...response.series[0]!, label: undefined }],
    };
    const lookup = reportUnitCostLookup(daily);
    expect(lookup.get("2026-10-01|USD")).toEqual({
      unit_cost_metric: "active_users",
      unit_cost_mode: "unit_cost",
      unit_cost_scope_cost: 20,
      unit_cost_metric_value: 10000,
      unit_cost_value: 2,
      unit_cost_gap: null,
    });
    expect(reportUnitCostLookup(response).size).toBe(0);
  });
});
