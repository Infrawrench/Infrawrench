import { describe, expect, it } from "vitest";
import { CostSetupError } from "@infrawrench/plugin-base";
import {
  billableByDay,
  dailyByCategory,
  fetchSentryCostData,
  fetchUsageSummary,
  monthsCovering,
} from "../cost-data.js";
import { parseRates } from "../rates.js";
import { ctxWith, makeHttp, stats } from "./helpers.js";

const NOW = Date.parse("2026-10-04T12:00:00Z");

describe("helpers", () => {
  it("covers every calendar month in the range", () => {
    expect(monthsCovering("2026-09-20", "2026-10-02")).toEqual([
      { start: "2026-09-01", end: "2026-10-01" },
      { start: "2026-10-01", end: "2026-11-01" },
    ]);
  });

  it("rolls error, default and security into errors and converts bytes to GB", () => {
    const daily = dailyByCategory(
      stats("2026-10-01", 2, [
        { by: { category: "error" }, series: [10, 20] },
        { by: { category: "default" }, series: [1, 0] },
        { by: { category: "attachment" }, series: [2e9, 0] },
        { by: { category: "monitor" }, series: [5, 5] },
      ]),
    );
    expect(daily.get("2026-10-01")?.get("errors")).toBe(11);
    expect(daily.get("2026-10-01")?.get("attachments")).toBe(2);
    expect(daily.get("2026-10-02")?.get("errors")).toBe(20);
    expect(daily.get("2026-10-01")?.has("monitor")).toBe(false);
  });

  it("is free until the month passes the included volume", () => {
    const daily = new Map([
      ["d1", new Map([["errors", 30]])],
      ["d2", new Map([["errors", 30]])],
      ["d3", new Map([["errors", 30]])],
    ]);
    expect([...billableByDay(["d1", "d2", "d3"], daily, "errors", 50).values()]).toEqual([
      0, 10, 30,
    ]);
  });
});

describe("fetchSentryCostData", () => {
  const rates = parseRates({ errorsIncluded: "50", errorPrice: "0.01", planFee: "26" });

  function route(seriesCalls: string[]) {
    return makeHttp((call) => {
      const p = call.url.searchParams;
      expect(call.url.pathname).toBe("/api/0/organizations/acme/stats_v2/");
      expect(call.headers["Authorization"]).toBe("Bearer sntryu_TEST");
      expect(p.getAll("outcome")).toEqual(["accepted"]);
      const groupBy = p.getAll("groupBy");
      if (groupBy.length === 1) {
        seriesCalls.push(p.get("start")!);
        // 30 errors a day from Oct 1.
        return stats("2026-10-01", 4, [{ by: { category: "error" }, series: [30, 30, 30, 30] }]);
      }
      expect(groupBy).toEqual(["category", "project"]);
      // Each day: 20 errors in project 1, 10 in project 2.
      return stats(p.get("start")!.slice(0, 10), 1, [
        { by: { category: "error", project: 1 }, total: 20 },
        { by: { category: "error", project: 2 }, total: 10 },
      ]);
    });
  }

  it("prices billable volume per day, split across projects, and adds the plan fee and monitors", async () => {
    const seriesCalls: string[] = [];
    const { http } = route(seriesCalls);
    const rows = await fetchSentryCostData(
      ctxWith(http),
      {
        org: "acme",
        rates,
        projectSlugs: new Map([
          ["1", "web"],
          ["2", "api"],
        ]),
        monitors: async () => ({ cron: 3, uptime: 1 }),
      },
      { fromDate: "2026-10-02", toDate: "2026-10-04" },
      NOW,
    );
    // The series is read from the 1st even though the range starts on the 2nd.
    expect(seriesCalls).toEqual(["2026-10-01T00:00:00Z"]);
    const errors = rows.filter((r) => r.service === "Errors");
    const byDay = (d: string) =>
      errors.filter((r) => r.date === d).reduce((a, r) => a + r.amount, 0);
    // Cumulative 30, 60, 90, 120 against 50 included: billable 0, 10, 30, 30.
    expect(byDay("2026-10-02")).toBeCloseTo(0.1);
    expect(byDay("2026-10-03")).toBeCloseTo(0.3);
    expect(
      errors.find((r) => r.date === "2026-10-03" && r.tags?.["project"] === "web"),
    ).toMatchObject({
      amount: 0.2,
      usageAmount: 20,
      usageUnit: "Events",
      region: "us",
      tags: { project: "web", projectId: "1" },
    });
    expect(errors.some((r) => r.date === "2026-10-01")).toBe(false);
    // Plan fee and monitors land on the 1st, which is outside the range here.
    expect(rows.some((r) => r.service === "Plan")).toBe(false);
  });

  it("dates the plan fee and the current month's monitors to the 1st", async () => {
    const { http } = route([]);
    const rows = await fetchSentryCostData(
      ctxWith(http),
      {
        org: "acme",
        rates,
        projectSlugs: new Map(),
        monitors: async () => ({ cron: 3, uptime: 1 }),
      },
      { fromDate: "2026-10-01", toDate: "2026-10-04" },
      NOW,
    );
    expect(rows.find((r) => r.service === "Plan")).toMatchObject({
      date: "2026-10-01",
      amount: 26,
    });
    expect(rows.find((r) => r.service === "Cron monitors")).toMatchObject({
      date: "2026-10-01",
      amount: 1.56,
      usageAmount: 3,
    });
    // One uptime monitor is included.
    expect(rows.find((r) => r.service === "Uptime monitors")).toMatchObject({ amount: 0 });
  });

  it("turns a 403 into a setup error naming the scope", async () => {
    const { http } = makeHttp(() => ({ status: 403, body: { detail: "nope" } }));
    await expect(
      fetchSentryCostData(
        ctxWith(http),
        { org: "acme", rates, projectSlugs: new Map() },
        { fromDate: "2026-10-01", toDate: "2026-10-02" },
        NOW,
      ),
    ).rejects.toBeInstanceOf(CostSetupError);
  });
});

describe("fetchUsageSummary", () => {
  it("totals outcomes per category and prices what is beyond the allowance", async () => {
    const { http } = makeHttp((call) => {
      const groupBy = call.url.searchParams.getAll("groupBy");
      if (groupBy.includes("outcome")) {
        return stats("2026-10-01", 4, [
          { by: { category: "error", outcome: "accepted" }, total: 60_000 },
          { by: { category: "error", outcome: "filtered" }, total: 500 },
          { by: { category: "error", outcome: "rate_limited" }, total: 25 },
          { by: { category: "span", outcome: "accepted" }, total: 1_000 },
        ]);
      }
      return stats("2026-10-01", 4, [
        { by: { category: "error", project: 1 }, total: 40_000 },
        { by: { category: "error", project: 2 }, total: 20_000 },
      ]);
    });
    const summary = await fetchUsageSummary(
      ctxWith(http),
      {
        org: "acme",
        rates: parseRates({}),
        projectSlugs: new Map([["1", "web"]]),
        monitors: async () => ({ cron: 2, uptime: 0 }),
      },
      NOW,
    );
    const errors = summary.categories.find((c) => c.key === "errors")!;
    expect(errors).toMatchObject({
      accepted: 60_000,
      filtered: 500,
      rateLimited: 25,
      billable: 10_000,
    });
    expect(errors.cost).toBeCloseTo(3.625);
    expect(summary.categories.find((c) => c.key === "spans")?.cost).toBe(0);
    expect(summary.categories.find((c) => c.key === "cronMonitors")?.cost).toBe(0.78);
    // Plan fee 26 + errors 3.625 + one billable cron monitor 0.78.
    expect(summary.totalCost).toBeCloseTo(30.405);
    expect(summary.byProject[0]).toEqual({ project: "web", errors: 40_000, spans: 0, replays: 0 });
    expect(summary.byProject[1]?.project).toBe("2");
  });
});
