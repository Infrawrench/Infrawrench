import { describe, expect, it } from "vitest";
import { CostSetupError } from "@infrawrench/plugin-base";
import {
  DEFAULT_UNIT_PRICE_USD,
  cellsToCostRows,
  chunkRange,
  fetchCoralogixCostData,
  parseUnitPrice,
} from "../cost-data.js";
import { cellsFromDailyRows, normalisePillar, normalisePriority } from "../usage.js";
import { ctxWith, makeHttp } from "./helpers.js";

const v = (value: number) => ({ value });

describe("parseUnitPrice", () => {
  it("defaults to the published $1.50", () => {
    expect(parseUnitPrice(undefined)).toBe(DEFAULT_UNIT_PRICE_USD);
    expect(parseUnitPrice("")).toBe(1.5);
  });

  it("accepts a dollar sign and a decimal comma", () => {
    expect(parseUnitPrice("$1.20")).toBe(1.2);
    expect(parseUnitPrice("0,95")).toBe(0.95);
  });

  it("rejects anything that is not a positive number", () => {
    expect(() => parseUnitPrice("free")).toThrow(CostSetupError);
    expect(() => parseUnitPrice("0")).toThrow(CostSetupError);
    expect(() => parseUnitPrice("-1")).toThrow(CostSetupError);
  });
});

describe("chunkRange", () => {
  it("splits into consecutive windows that cover the range exactly", () => {
    const chunks = chunkRange({ fromDate: "2026-01-01", toDate: "2026-03-05" }, 31);
    expect(chunks).toEqual([
      { fromDate: "2026-01-01", toDate: "2026-01-31" },
      { fromDate: "2026-02-01", toDate: "2026-03-03" },
      { fromDate: "2026-03-04", toDate: "2026-03-05" },
    ]);
  });

  it("returns one window for a single day", () => {
    expect(chunkRange({ fromDate: "2026-10-04", toDate: "2026-10-04" })).toEqual([
      { fromDate: "2026-10-04", toDate: "2026-10-04" },
    ]);
  });
});

describe("cellsFromDailyRows", () => {
  it("splits a day by pillar and priority and settles the rest against the total as blocked", () => {
    const cells = cellsFromDailyRows(
      {
        statsDate: "2026-10-01T00:00:00Z",
        totalUnits: v(10),
        highLogsUnits: v(4),
        mediumLogsUnits: v(2),
        lowTracingUnits: v(1),
        highMetricsUnits: v(1),
        blockedUnits: v(2),
      },
      {
        statsDate: "2026-10-01T00:00:00Z",
        totalGbs: v(40),
        highLogsGbs: v(5),
        mediumLogsGbs: v(6),
        lowTracingGbs: v(10),
        highMetricsGbs: v(4),
        blockedGbs: v(15),
      },
    );
    expect(cells).toEqual([
      { date: "2026-10-01", pillar: "logs", priority: "high", units: 4, gb: 5 },
      { date: "2026-10-01", pillar: "logs", priority: "medium", units: 2, gb: 6 },
      { date: "2026-10-01", pillar: "metrics", priority: "high", units: 1, gb: 4 },
      { date: "2026-10-01", pillar: "traces", priority: "low", units: 1, gb: 10 },
      { date: "2026-10-01", pillar: "logs", priority: "blocked", units: 2, gb: 15 },
    ]);
    expect(cells.reduce((s, c) => s + c.units, 0)).toBe(10);
  });

  it("files an unexplained remainder as other when nothing was blocked", () => {
    const cells = cellsFromDailyRows({
      statsDate: "2026-10-02T00:00:00Z",
      totalUnits: v(3),
      highLogsUnits: v(2),
    });
    expect(cells).toEqual([
      { date: "2026-10-02", pillar: "logs", priority: "high", units: 2 },
      { date: "2026-10-02", pillar: "other", units: 1 },
    ]);
  });

  it("does not double count blocked metrics when there is no total", () => {
    const cells = cellsFromDailyRows({
      statsDate: "2026-10-03T00:00:00Z",
      blockedUnits: v(3),
      blockedMetricsUnits: v(1),
    });
    expect(cells).toEqual([
      { date: "2026-10-03", pillar: "metrics", priority: "blocked", units: 1 },
      { date: "2026-10-03", pillar: "logs", priority: "blocked", units: 2 },
    ]);
  });
});

describe("normalise v5 labels", () => {
  it("maps pillar and priority values from either vocabulary", () => {
    expect(normalisePillar("PILLAR_SPANS")).toBe("traces");
    expect(normalisePillar("logs")).toBe("logs");
    expect(normalisePriority("PRIORITY_MEDIUM")).toBe("medium");
    expect(normalisePriority("TCO_TIER_HIGH")).toBe("high");
    expect(normalisePriority("compliance")).toBe("low");
    expect(normalisePriority("")).toBeUndefined();
  });
});

describe("cellsToCostRows", () => {
  it("prices units and tags rows with pillar and TCO priority", () => {
    const rows = cellsToCostRows(
      [
        { date: "2026-10-01", pillar: "logs", priority: "high", units: 4, gb: 5 },
        { date: "2026-10-01", pillar: "logs", priority: "high", units: 1 },
        { date: "2026-10-01", pillar: "ai", units: 0 },
      ],
      1.5,
      "eu2",
    );
    expect(rows).toEqual([
      {
        date: "2026-10-01",
        service: "Logs",
        region: "eu2",
        tags: { pillar: "logs", priority: "Frequent Search" },
        currency: "USD",
        amount: 7.5,
        usageAmount: 5,
        usageUnit: "units",
      },
    ]);
  });
});

describe("fetchCoralogixCostData", () => {
  it("reads daily units and GB from the v4 endpoints with bearer auth", async () => {
    const { http, calls } = makeHttp((url) => {
      if (url.pathname.endsWith("/daily/units")) {
        return {
          body: {
            units: [
              { statsDate: "2026-10-01T00:00:00Z", totalUnits: v(2), highLogsUnits: v(2) },
              // Outside the requested range: filtered.
              { statsDate: "2026-10-03T00:00:00Z", totalUnits: v(9), highLogsUnits: v(9) },
            ],
          },
        };
      }
      if (url.pathname.endsWith("/daily/processed-gbs")) {
        return { body: { gbs: [{ statsDate: "2026-10-01T00:00:00Z", highLogsGbs: v(2.6) }] } };
      }
      return { status: 404 };
    });
    const rows = await fetchCoralogixCostData(
      ctxWith(http),
      { fromDate: "2026-10-01", toDate: "2026-10-02" },
      1.2,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ service: "Logs", amount: 2.4, usageAmount: 2, region: "eu2" });
    const unitsCall = calls.find((c) => c.url.pathname.endsWith("/daily/units"))!;
    expect(unitsCall.url.origin).toBe("https://api.eu2.coralogix.com");
    expect(unitsCall.url.pathname).toBe("/mgmt/openapi/4/dataplans/data-usage/v2/daily/units");
    expect(unitsCall.method).toBe("POST");
    expect(unitsCall.headers["Authorization"]).toBe("Bearer test-key");
    expect(unitsCall.body).toEqual({
      dateRange: { fromDate: "2026-10-01T00:00:00.000Z", toDate: "2026-10-03T00:00:00.000Z" },
    });
  });

  it("falls back to the v5 query when the v4 route is gone", async () => {
    const { http, calls } = makeHttp((url) => {
      if (url.pathname.includes("/openapi/4/")) return { status: 404, body: { error: "gone" } };
      if (url.pathname.endsWith("/capabilities")) {
        return { body: { supportedLabels: [{ key: "pillar" }, { key: "priority" }] } };
      }
      if (url.pathname.endsWith("/v1/query")) {
        return {
          body: {
            buckets: [
              {
                range: { start: "2026-10-01T00:00:00Z", end: "2026-10-02T00:00:00Z" },
                entries: [
                  {
                    labels: [
                      { key: "pillar", value: "spans" },
                      { key: "priority", value: "low" },
                    ],
                    measurements: [
                      {
                        kind: "MEASUREMENT_KIND_PROCESSED_DATA_SIZE",
                        cxQuotaUnits: { value: "0.5" },
                        measuredUnit: "MEASUREMENT_UNIT_BYTES",
                        measuredValue: "5000000000",
                      },
                    ],
                  },
                ],
              },
            ],
          },
        };
      }
      return { status: 404 };
    });
    const rows = await fetchCoralogixCostData(
      ctxWith(http),
      { fromDate: "2026-10-01", toDate: "2026-10-01" },
      1.5,
    );
    expect(rows).toEqual([
      {
        date: "2026-10-01",
        service: "Traces",
        region: "eu2",
        tags: { pillar: "traces", priority: "Compliance" },
        currency: "USD",
        amount: 0.75,
        usageAmount: 0.5,
        usageUnit: "units",
      },
    ]);
    const query = calls.find((c) => c.url.pathname.endsWith("/v1/query"))!;
    expect(query.body).toEqual({
      daily: {
        dateRange: {
          start: { year: 2026, month: 10, day: 1 },
          end: { year: 2026, month: 10, day: 2 },
        },
      },
      groupBy: { keys: ["pillar", "priority"] },
    });
  });

  it("turns a permission refusal into a setup error", async () => {
    const { http } = makeHttp(() => ({ status: 403, body: { message: "forbidden" } }));
    await expect(
      fetchCoralogixCostData(ctxWith(http), { fromDate: "2026-10-01", toDate: "2026-10-01" }, 1.5),
    ).rejects.toBeInstanceOf(CostSetupError);
  });

  it("skips an old window the server will not answer, but not the newest", async () => {
    const { http } = makeHttp((url, _m, body) => {
      const from = (body as { dateRange?: { fromDate?: string } })?.dateRange?.fromDate ?? "";
      if (url.pathname.endsWith("/daily/units")) {
        if (from.startsWith("2026-01")) return { status: 400, body: { message: "too old" } };
        return {
          body: {
            units: [{ statsDate: "2026-02-10T00:00:00Z", totalUnits: v(1), highLogsUnits: v(1) }],
          },
        };
      }
      return { body: { gbs: [] } };
    });
    const rows = await fetchCoralogixCostData(
      ctxWith(http),
      { fromDate: "2026-01-01", toDate: "2026-02-15" },
      1.5,
    );
    expect(rows.map((r) => r.date)).toEqual(["2026-02-10"]);
  });
});
