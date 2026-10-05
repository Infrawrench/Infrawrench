/**
 * The cost display options against the SQL the readers actually emit: the
 * quarterly bucket, the usage measure's quantity column and unit predicate,
 * the count measure's two-level distinct count, and the refusal to bin a
 * day-keyed table by the hour.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakeClickHouse } from "./helpers/fake-clickhouse";

const ch = fakeClickHouse();

vi.mock("../clickhouse/client", () => ({
  isClickHouseConfigured: () => true,
  getClickHouseDb: () => ch.db,
  getClickHouseClient: () => ch.client,
}));

const { queryCosts, queryCostCounts, getCostUsageUnits, COST_STORE_GRANULARITY } =
  await import("../clickhouse/cost-readers");

const baseQuery = {
  from: "2026-01-01",
  to: "2026-09-30",
  binning: "quarterly" as const,
  groupBy: "service" as const,
  filters: [],
};

beforeEach(() => {
  ch.reset();
});

describe("bins", () => {
  it("buckets quarterly bins with toStartOfQuarter", async () => {
    await queryCosts("org", baseQuery);
    expect(ch.lastQuery()).toContain("toStartOfQuarter(`day`)");
  });

  it("refuses hourly bins without issuing a query", async () => {
    expect(COST_STORE_GRANULARITY).toBe("daily");
    await expect(queryCosts("org", { ...baseQuery, binning: "hourly" })).rejects.toThrow(/Hourly/);
    expect(ch.queries).toHaveLength(0);
  });

  it("applies the cumulative toggle as a running sum at any bin size", async () => {
    ch.setRows([
      { bucket: "2026-01-01", grp: "EC2", currency: "USD", amount: 10 },
      { bucket: "2026-04-01", grp: "EC2", currency: "USD", amount: 5 },
    ]);
    const groups = await queryCosts("org", { ...baseQuery, cumulative: true });
    expect(groups[0]!.points.map((p) => p.amount)).toEqual([10, 15]);
  });
});

describe("usage", () => {
  it("sums the quantity column over one unit and folds currencies together", async () => {
    ch.setRows([
      { bucket: "2026-01-01", grp: "EC2", currency: "USD", amount: 100 },
      { bucket: "2026-01-01", grp: "EC2", currency: "EUR", amount: 50 },
    ]);
    const groups = await queryCosts("org", { ...baseQuery, measure: "usage", usageUnit: "Hrs" });
    const sql = ch.lastQuery();
    expect(sql).toContain("sum(`cost_daily`.`usage_amount`)");
    expect(sql).toContain("`cost_daily`.`usage_unit` = 'Hrs'");
    // Same hours whichever currency they were billed in: one series, no currency.
    expect(groups).toEqual([
      { key: "EC2", currency: "", points: [{ bucket: "2026-01-01", amount: 150 }] },
    ]);
  });
});

describe("count", () => {
  it("counts distinct nonzero values per bin and over the whole range", async () => {
    await queryCostCounts("org", { ...baseQuery, measure: "count" });
    expect(ch.queries).toHaveLength(2);
    for (const sql of ch.queries) {
      expect(sql).toContain("uniqExact(");
      expect(sql).toContain("!= 0");
      // Empty values (no resource id, untagged) are not a value.
      expect(sql).toContain("`cost_daily`.`service` != ''");
      expect(sql).toContain("final");
    }
    // One statement bins, the other does not.
    expect(ch.queries.filter((q) => q.includes("toStartOfQuarter"))).toHaveLength(1);
  });

  it("is what queryCosts answers for the count measure", async () => {
    await queryCosts("org", { ...baseQuery, measure: "count" });
    expect(ch.queries.some((q) => q.includes("uniqExact("))).toBe(true);
  });

  it("refuses an ungrouped count", async () => {
    await expect(
      queryCostCounts("org", { ...baseQuery, groupBy: "none", measure: "count" }),
    ).rejects.toThrow(/groupBy/);
  });
});

describe("usage units", () => {
  it("lists non-empty units, most used first", async () => {
    ch.setRows([
      { unit: "Hrs", rows: "40" },
      { unit: "GB-Mo", rows: "3" },
    ]);
    expect(await getCostUsageUnits("org")).toEqual(["Hrs", "GB-Mo"]);
    expect(ch.lastQuery()).toContain("`cost_daily`.`usage_unit` != ''");
  });
});
