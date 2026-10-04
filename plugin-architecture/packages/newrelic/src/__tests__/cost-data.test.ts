import { describe, expect, it } from "vitest";
import { CostSetupError } from "@infrawrench/plugin-base";
import {
  dailyIncrements,
  facetValue,
  fetchNewRelicCostData,
  fetchUsageSummary,
  monthClause,
  monthsCovering,
} from "../cost-data.js";
import { parseRates } from "../rates.js";
import { ctxWith, day, makeHttp, nrqlData } from "./helpers.js";

const NOW = Date.parse("2026-10-04T12:00:00Z");

describe("month helpers", () => {
  it("covers every calendar month in the range, across a year end", () => {
    expect(monthsCovering("2025-12-15", "2026-02-02")).toEqual([
      { start: "2025-12-01", end: "2026-01-01" },
      { start: "2026-01-01", end: "2026-02-01" },
      { start: "2026-02-01", end: "2026-03-01" },
    ]);
  });

  it("clamps the current month to now and quotes past months", () => {
    expect(monthClause({ start: "2026-10-01", end: "2026-11-01" }, NOW)).toBe(
      "SINCE '2026-10-01 00:00:00' UNTIL now WITH TIMEZONE 'UTC'",
    );
    expect(monthClause({ start: "2026-09-01", end: "2026-10-01" }, NOW)).toBe(
      "SINCE '2026-09-01 00:00:00' UNTIL '2026-10-01 00:00:00' WITH TIMEZONE 'UTC'",
    );
  });

  it("differences month-to-date values into days, carrying gaps and never going negative", () => {
    const days = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"];
    const mtd = new Map([
      ["2026-09-01", 10],
      ["2026-09-03", 12],
      ["2026-09-04", 11],
    ]);
    expect([...dailyIncrements(days, mtd).values()]).toEqual([10, 0, 2, 0]);
  });

  it("reads facets by name, then by position", () => {
    expect(facetValue({ usageMetric: "Logs" }, "usageMetric", 2)).toBe("Logs");
    expect(facetValue({ facet: ["1", "Prod", "APM"] }, "usageMetric", 2)).toBe("APM");
    expect(facetValue({ facet: "CoreCCU" }, "metric", 0)).toBe("CoreCCU");
  });
});

describe("fetchNewRelicCostData", () => {
  function route(nrql: string) {
    if (nrql.includes("FROM NrConsumption WHERE productLine = 'DataPlatform'")) {
      // 60 GB on the 1st, 60 GB on the 2nd (split 40/20 across sources).
      return nrqlData([
        {
          beginTimeSeconds: day("2026-09-01"),
          consumingAccountId: 1,
          consumingAccountName: "Prod",
          usageMetric: "Logs",
          gb: 60,
        },
        {
          beginTimeSeconds: day("2026-09-02"),
          consumingAccountId: 1,
          consumingAccountName: "Prod",
          usageMetric: "Logs",
          gb: 40,
        },
        {
          beginTimeSeconds: day("2026-09-02"),
          consumingAccountId: 2,
          consumingAccountName: "Staging",
          usageMetric: "Metrics",
          gb: 20,
        },
      ]);
    }
    if (nrql.includes("FullPlatformUsersBillable")) {
      return nrqlData([
        { beginTimeSeconds: day("2026-09-01"), full: 3, core: 1 },
        { beginTimeSeconds: day("2026-09-10"), full: 4, core: 1 },
      ]);
    }
    if (nrql.includes("SyntheticChecks")) {
      return nrqlData([{ beginTimeSeconds: day("2026-09-05"), billable: 1000 }]);
    }
    if (nrql.includes("CoreCCU")) {
      return nrqlData([
        {
          beginTimeSeconds: day("2026-09-03"),
          metric: "CoreCCU",
          dimension_productCapability: "Queries",
          consumingAccountId: 1,
          consumingAccountName: "Prod",
          ccu: 500,
        },
      ]);
    }
    throw new Error(`unexpected NRQL: ${nrql}`);
  }

  it("prices ingest above the free allowance, user increments and checks, by day", async () => {
    const { http, calls } = makeHttp((c) => route(String(c.variables["nrql"])));
    const rows = await fetchNewRelicCostData(
      ctxWith(http),
      42,
      parseRates({}),
      { fromDate: "2026-09-01", toDate: "2026-09-30" },
      NOW,
    );
    expect(calls.every((c) => c.variables["accountId"] === 42)).toBe(true);
    expect(calls.every((c) => c.headers["API-Key"] === "NRAK-TEST")).toBe(true);
    // Compute is skipped without a CCU rate.
    expect(calls.some((c) => String(c.variables["nrql"]).includes("CoreCCU"))).toBe(false);

    const ingest = rows.filter((r) => r.service === "Data ingest");
    // Day 1: 60 GB, all inside the 100 GB allowance.
    const d1 = ingest.find((r) => r.date === "2026-09-01")!;
    expect(d1.amount).toBe(0);
    expect(d1.usageAmount).toBe(60);
    expect(d1.tags).toEqual({ account: "Prod", accountId: "1", source: "Logs" });
    // Day 2: 60 GB more, 20 GB billable, split 40:20 across the two cells.
    const prod = ingest.find((r) => r.date === "2026-09-02" && r.tags?.["account"] === "Prod")!;
    const staging = ingest.find(
      (r) => r.date === "2026-09-02" && r.tags?.["account"] === "Staging",
    )!;
    expect(prod.amount).toBeCloseTo(((20 * 40) / 60) * 0.4, 6);
    expect(staging.amount).toBeCloseTo(((20 * 20) / 60) * 0.4, 6);
    expect(prod.region).toBe("us");

    const users = rows.filter((r) => r.service === "Full platform users");
    expect(users.map((r) => [r.date, r.usageAmount, r.amount])).toEqual([
      ["2026-09-01", 3, 3 * 349],
      ["2026-09-10", 1, 349],
    ]);
    expect(rows.find((r) => r.service === "Core users")?.amount).toBe(49);
    expect(rows.find((r) => r.service === "Synthetic checks")?.amount).toBe(5);
    expect(rows.every((r) => r.currency === "USD")).toBe(true);
  });

  it("only returns days inside the range but still reads the month from its 1st", async () => {
    const { http, calls } = makeHttp((c) => route(String(c.variables["nrql"])));
    const rows = await fetchNewRelicCostData(
      ctxWith(http),
      42,
      parseRates({}),
      { fromDate: "2026-09-02", toDate: "2026-09-30" },
      NOW,
    );
    expect(String(calls[0]!.variables["nrql"])).toContain("SINCE '2026-09-01 00:00:00'");
    expect(rows.some((r) => r.date < "2026-09-02")).toBe(false);
    // The allowance was still consumed by the 1st.
    const total = rows.filter((r) => r.service === "Data ingest").reduce((s, r) => s + r.amount, 0);
    expect(total).toBeCloseTo(20 * 0.4, 6);
  });

  it("adds compute rows once a CCU rate is configured", async () => {
    const { http } = makeHttp((c) => route(String(c.variables["nrql"])));
    const rows = await fetchNewRelicCostData(
      ctxWith(http),
      42,
      parseRates({ coreCcuPrice: "0.25" }),
      { fromDate: "2026-09-01", toDate: "2026-09-30" },
      NOW,
    );
    const compute = rows.find((r) => r.service === "Core compute")!;
    expect(compute.amount).toBe(125);
    expect(compute.usageUnit).toBe("CCU");
    expect(compute.tags).toEqual({ account: "Prod", accountId: "1", capability: "Queries" });
  });

  it("turns a permission error into a setup error naming the account", async () => {
    const { http } = makeHttp(() => ({
      errors: [{ message: "Access denied", extensions: { errorClass: "FORBIDDEN" } }],
    }));
    await expect(
      fetchNewRelicCostData(
        ctxWith(http),
        42,
        parseRates({}),
        {
          fromDate: "2026-09-01",
          toDate: "2026-09-30",
        },
        NOW,
      ),
    ).rejects.toBeInstanceOf(CostSetupError);
  });

  it("uses the EU endpoint for an EU account", async () => {
    const { http, calls } = makeHttp((c) => route(String(c.variables["nrql"])));
    await fetchNewRelicCostData(
      ctxWith(http, "eu"),
      42,
      parseRates({}),
      {
        fromDate: "2026-09-01",
        toDate: "2026-09-01",
      },
      NOW,
    );
    expect(calls.every((c) => c.url === "https://api.eu.newrelic.com/graphql")).toBe(true);
  });
});

describe("rates", () => {
  it("defaults to list prices and accepts overrides with a $ sign", () => {
    const r = parseRates({ dataPricePerGb: "$0.30" });
    expect(r.dataPerGb).toBe(0.3);
    expect(r.fullPlatformUser).toBe(349);
    expect(r.coreCcu).toBeUndefined();
  });

  it("rejects a rate that is not a number", () => {
    expect(() => parseRates({ coreUserPrice: "cheap" })).toThrow(/Core user price/);
  });
});

describe("fetchUsageSummary", () => {
  it("estimates month-to-date cost per product", async () => {
    const { http } = makeHttp((c) => {
      const nrql = String(c.variables["nrql"]);
      if (nrql.includes("latest(GigabytesIngested)")) {
        return nrqlData([{ gb: 250, billableGb: 150, full: 2, core: 3, basic: 40 }]);
      }
      if (nrql.includes("CoreCCU"))
        return nrqlData([{ facet: "CoreCCU", metric: "CoreCCU", ccu: 10 }]);
      if (nrql.includes("SyntheticChecks")) return nrqlData([{ free: 10000, billable: 0 }]);
      if (nrql.includes("FACET consumingAccountName")) {
        return nrqlData([{ consumingAccountName: "Prod", gb: 200 }]);
      }
      return nrqlData([{ usageMetric: "Logs", gb: 250 }]);
    });
    const s = await fetchUsageSummary(ctxWith(http), 42, parseRates({}), NOW);
    expect(s.month).toBe("2026-10");
    expect(s.totalCost).toBeCloseTo(150 * 0.4 + 2 * 349 + 3 * 49, 6);
    expect(s.costs.find((c) => c.product === "Core compute")?.amount).toBeUndefined();
    expect(s.byAccount).toEqual([{ account: "Prod", gigabytes: 200 }]);
  });
});
