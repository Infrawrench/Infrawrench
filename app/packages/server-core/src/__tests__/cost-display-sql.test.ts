/**
 * The cost display options against the SQL the readers actually emit: the
 * quarterly bucket, the usage measure's quantity column and unit predicate,
 * the count measure's two-level distinct count, and the refusal to bin a
 * day-keyed table by the hour.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakePostgres } from "./helpers/fake-postgres";
import { inlineSql } from "./helpers/inline-sql";

const pg = fakePostgres();
const last = () => inlineSql(pg.lastQuery());
const all = () => pg.queries.map(inlineSql);

vi.mock("../analytics/client", () => ({ getAnalyticsDb: () => pg.db }));

const { queryCosts, queryCostCounts, getCostUsageUnits, COST_STORE_GRANULARITY } =
  await import("../analytics/cost-readers");

const baseQuery = {
  from: "2026-01-01",
  to: "2026-09-30",
  binning: "quarterly" as const,
  groupBy: "service" as const,
  filters: [],
};

beforeEach(() => {
  pg.reset();
});

const QUARTER = `to_char(date_trunc('quarter', "cost_daily"."day"::timestamp), 'YYYY-MM-DD')`;

describe("bins", () => {
  it("buckets quarterly bins at the quarter's first day", async () => {
    await queryCosts("org", baseQuery);
    expect(last()).toContain(QUARTER);
  });

  it("refuses hourly bins without issuing a query", async () => {
    expect(COST_STORE_GRANULARITY).toBe("daily");
    await expect(queryCosts("org", { ...baseQuery, binning: "hourly" })).rejects.toThrow(/Hourly/);
    expect(pg.queries).toHaveLength(0);
  });

  it("applies the cumulative toggle as a running sum at any bin size", async () => {
    pg.setRows([
      { bucket: "2026-01-01", grp: "EC2", currency: "USD", amount: 10 },
      { bucket: "2026-04-01", grp: "EC2", currency: "USD", amount: 5 },
    ]);
    const groups = await queryCosts("org", { ...baseQuery, cumulative: true });
    expect(groups[0]!.points.map((p) => p.amount)).toEqual([10, 15]);
  });
});

describe("usage", () => {
  it("sums the quantity column over one unit and folds currencies together", async () => {
    pg.setRows([
      { bucket: "2026-01-01", grp: "EC2", currency: "USD", amount: 100 },
      { bucket: "2026-01-01", grp: "EC2", currency: "EUR", amount: 50 },
    ]);
    const groups = await queryCosts("org", { ...baseQuery, measure: "usage", usageUnit: "Hrs" });
    const sql = last();
    expect(sql).toContain(`sum("cost_daily"."usage_amount")`);
    expect(sql).toContain(`"cost_daily"."usage_unit" = 'Hrs'`);
    // Same hours whichever currency they were billed in: one series, no currency.
    expect(groups).toEqual([
      { key: "EC2", currency: "", points: [{ bucket: "2026-01-01", amount: 150 }] },
    ]);
  });
});

describe("count", () => {
  it("counts distinct nonzero values per bin and over the whole range", async () => {
    await queryCostCounts("org", { ...baseQuery, measure: "count" });
    expect(pg.queries).toHaveLength(2);
    for (const sql of all()) {
      expect(sql).toContain("count(DISTINCT ");
      expect(sql).toContain("!= 0");
      // Empty values (no resource id, untagged) are not a value.
      expect(sql).toContain(`"cost_daily"."service" != ''`);
    }
    // One statement bins, the other does not.
    expect(all().filter((q) => q.includes("date_trunc('quarter'"))).toHaveLength(1);
  });

  it("is what queryCosts answers for the count measure", async () => {
    await queryCosts("org", { ...baseQuery, measure: "count" });
    expect(all().some((q) => q.includes("count(DISTINCT "))).toBe(true);
  });

  it("refuses an ungrouped count", async () => {
    await expect(
      queryCostCounts("org", { ...baseQuery, groupBy: "none", measure: "count" }),
    ).rejects.toThrow(/groupBy/);
  });
});

describe("usage units", () => {
  it("lists non-empty units, most used first", async () => {
    pg.setRows([
      { unit: "Hrs", row_count: "40" },
      { unit: "GB-Mo", row_count: "3" },
    ]);
    expect(await getCostUsageUnits("org")).toEqual(["Hrs", "GB-Mo"]);
    expect(last()).toContain(`"cost_daily"."usage_unit" != ''`);
  });
});

describe("dimension X axis", () => {
  it("puts the X dimension ahead of the segment in one group key, keeping date buckets", async () => {
    await queryCosts("org", { ...baseQuery, xAxis: "provider", groupBy: "region" });
    const sql = last();
    expect(sql).toContain(
      `("cost_daily"."plugin_id" || '\u001f'::text || "cost_daily"."region") as "grp"`,
    );
    // The bins stay in the scan: conversion picks each day's rate from them.
    expect(sql).toContain(QUARTER);
  });

  it("groups by the X dimension alone when there is no segment dimension", async () => {
    await queryCosts("org", {
      ...baseQuery,
      xAxis: "region",
      groupBy: "none",
      segmentByDate: true,
    });
    const sql = last();
    expect(sql).not.toContain("||");
    expect(sql).toContain(`"region" as "grp"`);
  });
});
