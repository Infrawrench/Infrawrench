import { beforeEach, describe, expect, it } from "vitest";
import { CostSetupError } from "@infrawrench/plugin-base";
import { resetCachesForTests } from "../account.js";
import {
  fetchBillSummary,
  fetchGrafanaCostData,
  monthStartsInRange,
  rowsForMonth,
  splitAmount,
} from "../cost-data.js";
import { ctxWith, makeHttp } from "./helpers.js";

beforeEach(() => resetCachesForTests());

const STACKS = [
  { id: 11, slug: "acme-prod", regionSlug: "prod-us-east-0" },
  { id: 12, slug: "acme-dev", regionSlug: "prod-eu-west-2" },
];

function billed(month: number) {
  return {
    items: [
      {
        id: 1,
        dimensionId: "hl",
        dimensionName: "Logs",
        unit: "GB",
        includedUsage: 50,
        totalUsage: 250,
        overage: 200,
        amountDue: 100,
        periodStart: `2026-${String(month).padStart(2, "0")}-01T00:00:00Z`,
        usages: [
          { stackId: 11, stackName: "acme-prod.grafana.net", totalUsage: 200, isProrated: false },
          { stackId: 12, stackName: "acme-dev.grafana.net", totalUsage: 50, isProrated: false },
        ],
      },
      {
        id: 2,
        dimensionId: "hm",
        dimensionName: "Metrics",
        unit: "series",
        totalUsage: 30000,
        amountDue: 130.01,
        usages: [
          { stackId: 11, totalUsage: 1, attributedCost: 1 },
          { stackId: 12, totalUsage: 1, attributedCost: 2 },
        ],
      },
      {
        id: 3,
        dimensionId: "k6-vuh",
        dimensionName: "k6",
        unit: "VUh",
        totalUsage: 0,
        amountDue: 0,
      },
    ],
  };
}

function route(url: URL) {
  if (url.pathname === "/api/orgs/4242") return { body: { id: 4242, slug: "acme" } };
  if (url.pathname === "/api/orgs/acme/instances") return { body: { items: STACKS } };
  if (url.pathname === "/api/orgs/acme/billed-usage") {
    return { body: billed(Number(url.searchParams.get("month"))) };
  }
  return { status: 404, body: { message: "not found" } };
}

describe("monthStartsInRange", () => {
  it("lists only months whose 1st lies in the range, not past today", () => {
    expect(monthStartsInRange("2026-08-15", "2026-11-30", "2026-10-04")).toEqual([
      "2026-09-01",
      "2026-10-01",
    ]);
    expect(monthStartsInRange("2025-12-01", "2026-01-31", "2026-10-04")).toEqual([
      "2025-12-01",
      "2026-01-01",
    ]);
  });
});

describe("splitAmount", () => {
  it("splits proportionally to cents and keeps the total exact", () => {
    const parts = splitAmount(100, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 10);
    expect(parts).toEqual([33.34, 33.33, 33.33]);
  });
  it("splits evenly when every weight is zero", () => {
    expect(splitAmount(10, [0, 0])).toEqual([5, 5]);
  });
});

describe("rowsForMonth", () => {
  it("prefers attributedCost and falls back to usage share", () => {
    const stacks = new Map([
      [11, { slug: "acme-prod", region: "prod-us-east-0" }],
      [12, { slug: "acme-dev", region: "prod-eu-west-2" }],
    ]);
    const rows = rowsForMonth("2026-10-01", billed(10).items, stacks);
    expect(rows).toContainEqual({
      date: "2026-10-01",
      service: "Logs",
      region: "prod-us-east-0",
      resourceId: "acme-prod",
      tags: { stack: "acme-prod" },
      currency: "USD",
      amount: 80,
      usageAmount: 200,
      usageUnit: "GB",
    });
    const metrics = rows.filter((r) => r.service === "Metrics");
    expect(metrics.map((r) => r.amount)).toEqual([43.34, 86.67]);
    expect(rows.some((r) => r.service === "k6")).toBe(false);
  });
});

describe("fetchGrafanaCostData", () => {
  it("dates each month to its 1st and resolves the org from the token", async () => {
    const { http, calls } = makeHttp(route);
    const rows = await fetchGrafanaCostData(
      ctxWith(http),
      "",
      { fromDate: "2026-08-20", toDate: "2026-10-04" },
      new Date("2026-10-04T12:00:00Z"),
    );
    expect(new Set(rows.map((r) => r.date))).toEqual(new Set(["2026-09-01", "2026-10-01"]));
    const total = rows.filter((r) => r.date === "2026-10-01").reduce((a, r) => a + r.amount, 0);
    expect(total).toBeCloseTo(230.01, 6);
    expect(calls[0]?.headers["Authorization"]).toMatch(/^Bearer glc_/);
    expect(calls.some((c) => c.url.searchParams.get("month") === "9")).toBe(true);
  });

  it("turns a 403 into a CostSetupError naming the scope", async () => {
    const { http } = makeHttp((url) =>
      url.pathname.endsWith("/billed-usage") ? { status: 403, body: {} } : route(url),
    );
    await expect(
      fetchGrafanaCostData(ctxWith(http), "", { fromDate: "2026-10-01", toDate: "2026-10-04" }),
    ).rejects.toBeInstanceOf(CostSetupError);
  });
});

describe("fetchBillSummary", () => {
  it("totals the month and splits it by stack", async () => {
    const { http } = makeHttp(route);
    const bill = await fetchBillSummary(ctxWith(http), "", new Date("2026-10-04T00:00:00Z"));
    expect(bill.month).toBe("2026-10");
    expect(bill.total).toBeCloseTo(230.01, 6);
    expect(bill.stacks.map((s) => s.stack)).toEqual(["acme-prod", "acme-dev"]);
  });
});
