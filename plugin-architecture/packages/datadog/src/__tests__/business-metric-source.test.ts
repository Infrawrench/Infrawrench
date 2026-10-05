import { describe, expect, it } from "vitest";
import type { BusinessMetricSourceRange } from "@infrawrench/plugin-base";
import {
  DATADOG_BUSINESS_METRIC_SOURCE,
  DD_MAX_POINTS_PER_SERIES,
  datadogMetricQuery,
  listDatadogMetricSourceOptions,
  parseDatadogMetricParams,
  rollupSecondsFor,
  runDatadogMetricSource,
} from "../business-metric-source.js";
import { plugin } from "../plugin.js";
import { ctxWith, makeHttp, type Reply } from "./helpers.js";

const NOW = Date.parse("2026-10-04T12:00:00Z");
const HOUR = 3_600_000;

function range(over: Partial<BusinessMetricSourceRange> = {}): BusinessMetricSourceRange {
  return {
    from: "2026-09-01",
    to: "2026-09-02",
    timezone: "UTC",
    maxRows: 50_000,
    timeoutMs: 5_000,
    ...over,
  };
}

/** A v2 timeseries answer: hourly buckets from `from`, one value row per series. */
function timeseries(
  fromMs: number,
  rows: Array<{ tags?: string[]; values: Array<number | null> }>,
  stepMs = HOUR,
): Reply {
  const n = Math.max(0, ...rows.map((r) => r.values.length));
  return {
    body: {
      data: {
        type: "timeseries_response",
        attributes: {
          series: rows.map((r, i) => ({ group_tags: r.tags ?? [], query_index: i })),
          times: Array.from({ length: n }, (_, i) => fromMs + i * stepMs),
          values: rows.map((r) => r.values),
        },
      },
    },
  };
}

const params = {
  metric: "app.orders.placed",
  scope: "env:prod",
  spaceAggregation: "sum",
  rollup: "sum",
};

describe("manifest", () => {
  it("declares a read-only metric source wired to the client", () => {
    expect(plugin.manifest.businessMetricSource).toBe(DATADOG_BUSINESS_METRIC_SOURCE);
    expect(DATADOG_BUSINESS_METRIC_SOURCE).toMatchObject({ kind: "metric", readOnly: "enforced" });
    expect(DATADOG_BUSINESS_METRIC_SOURCE.fields.map((f) => f.key)).toEqual([
      "metric",
      "scope",
      "groupBy",
      "spaceAggregation",
      "valueMode",
      "rollup",
    ]);
    const client = plugin.createClient({ site: "us1", apiKey: "a", appKey: "b" }, {} as never);
    expect(typeof client.listBusinessMetricSourceOptions).toBe("function");
    expect(typeof client.runBusinessMetricSource).toBe("function");
  });
});

describe("params", () => {
  it("builds the metric query from validated parts", () => {
    const p = parseDatadogMetricParams({ ...params, groupBy: "team", valueMode: "count" });
    expect(datadogMetricQuery(p)).toBe("sum:app.orders.placed{env:prod} by {team}.as_count()");
    expect(datadogMetricQuery(parseDatadogMetricParams({ metric: "m.x" }))).toBe("sum:m.x{*}");
  });

  it("refuses anything that could break out of the query", () => {
    expect(() => parseDatadogMetricParams({ metric: "m{*}" })).toThrow(/metric name/);
    expect(() => parseDatadogMetricParams({ metric: "m", scope: "env:prod}+sum:other{*" })).toThrow(
      /tags/,
    );
    expect(() => parseDatadogMetricParams({ metric: "m", groupBy: "team} by {x" })).toThrow(
      /tag key/,
    );
    expect(() => parseDatadogMetricParams({ metric: "m", rollup: "median" })).toThrow(/rollup/);
    expect(() => parseDatadogMetricParams({ metric: "" })).toThrow(/Pick/);
  });
});

describe("pickers", () => {
  it("lists actively reporting metrics, sorted and de-duplicated", async () => {
    const { http, calls } = makeHttp(() => ({ body: { metrics: ["b.m", "a.m", "b.m"] } }));
    const options = await listDatadogMetricSourceOptions(ctxWith(http), "metric", {}, NOW);
    expect(options.map((o) => o.id)).toEqual(["a.m", "b.m"]);
    expect(calls[0]!.url.pathname).toBe("/api/v1/metrics");
    expect(Number(calls[0]!.url.searchParams.get("from"))).toBe(NOW / 1000 - 7 * 86_400);
  });

  it("offers a metric's tags as scopes and their keys as breakdowns", async () => {
    const { http, calls } = makeHttp(() => ({
      body: { data: { attributes: { tags: ["team:payments", "env:prod", "team:search"] } } },
    }));
    const ctx = ctxWith(http);
    const scopes = await listDatadogMetricSourceOptions(ctx, "scope", { metric: "app.orders" });
    expect(scopes.map((o) => o.id)).toEqual(["*", "env:prod", "team:payments", "team:search"]);
    const groups = await listDatadogMetricSourceOptions(ctx, "groupBy", { metric: "app.orders" });
    expect(groups.map((o) => [o.id, o.description])).toEqual([
      ["", "One value per day"],
      ["env", "1 value"],
      ["team", "2 values"],
    ]);
    expect(calls[0]!.url.pathname).toBe("/api/v2/metrics/app.orders/all-tags");
    expect(calls[0]!.url.searchParams.get("window[seconds]")).toBe(String(7 * 86_400));
  });

  it("does not call Datadog for tags before a metric is picked", async () => {
    const { http, calls } = makeHttp(() => ({ body: {} }));
    expect(await listDatadogMetricSourceOptions(ctxWith(http), "scope", {})).toEqual([
      expect.objectContaining({ id: "*" }),
    ]);
    expect(calls).toHaveLength(0);
  });
});

describe("rollup width", () => {
  it("is an hour where local midnight falls on the hour, fifteen minutes where it does not", () => {
    expect(rollupSecondsFor("2026-03-28", "2026-03-30", "Europe/London")).toBe(3600);
    expect(rollupSecondsFor("2026-09-01", "2026-09-02", "Asia/Kolkata")).toBe(900);
    expect(rollupSecondsFor("2026-09-01", "2026-09-02", "Asia/Kathmandu")).toBe(900);
  });
});

describe("run", () => {
  it("reads hourly buckets over the window and files each under its local day", async () => {
    const from = Date.parse("2026-09-01T00:00:00Z");
    const { http, calls } = makeHttp(() =>
      timeseries(from, [{ values: [5, null, 7, ...Array<number>(21).fill(0), 2] }]),
    );
    const result = await runDatadogMetricSource(ctxWith(http), params, range(), NOW);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url.pathname).toBe("/api/v2/query/timeseries");
    expect(calls[0]!.body).toEqual({
      data: {
        type: "timeseries_request",
        attributes: {
          from,
          to: Date.parse("2026-09-03T00:00:00Z"),
          interval: HOUR,
          queries: [
            {
              data_source: "metrics",
              name: "a",
              query: "sum:app.orders.placed{env:prod}.rollup(sum, 3600)",
            },
          ],
        },
      },
    });
    // The null bucket is a gap, not a zero; the 25th hour is the next day.
    expect(result.points.filter((p) => p.date === "2026-09-01").map((p) => p.value)).toEqual([
      5,
      7,
      ...Array<number>(21).fill(0),
    ]);
    expect(result.points.filter((p) => p.date === "2026-09-02")).toEqual([
      { date: "2026-09-02", value: 2 },
    ]);
    expect(result.notes?.[0]).toMatch(/hourly points of sum:app\.orders\.placed\{env:prod\}/);
  });

  it("labels each group's points by its tag value", async () => {
    const from = Date.parse("2026-09-01T00:00:00Z");
    const { http } = makeHttp(() =>
      timeseries(from, [
        { tags: ["team:payments"], values: [3] },
        { tags: ["team:search"], values: [4] },
      ]),
    );
    const result = await runDatadogMetricSource(
      ctxWith(http),
      { ...params, groupBy: "team" },
      range({ to: "2026-09-01" }),
      NOW,
    );
    expect(result.points).toEqual([
      { date: "2026-09-01", value: 3, label: "payments" },
      { date: "2026-09-01", value: 4, label: "search" },
    ]);
    expect(result.notes?.[0]).toMatch(/2 team values/);
  });

  it("uses local days: an hour after UTC midnight is still yesterday in New York", async () => {
    const from = Date.parse("2026-09-01T04:00:00Z"); // midnight EDT
    const { http, calls } = makeHttp(() => timeseries(from, [{ values: [1] }]));
    const result = await runDatadogMetricSource(
      ctxWith(http),
      params,
      range({ from: "2026-09-01", to: "2026-09-01", timezone: "America/New_York" }),
      NOW,
    );
    expect(
      (calls[0]!.body as { data: { attributes: { from: number } } }).data.attributes.from,
    ).toBe(from);
    expect(result.points).toEqual([{ date: "2026-09-01", value: 1 }]);
  });

  it("splits a long window so no series exceeds Datadog's point ceiling", async () => {
    const { http, calls } = makeHttp(() => ({ body: { data: { attributes: {} } } }));
    await runDatadogMetricSource(
      ctxWith(http),
      params,
      range({ from: "2026-01-01", to: "2026-06-30" }),
      NOW,
    );
    const spans = calls.map((c) => {
      const a = (c.body as { data: { attributes: { from: number; to: number } } }).data.attributes;
      return (a.to - a.from) / HOUR;
    });
    expect(Math.max(...spans)).toBeLessThanOrEqual(DD_MAX_POINTS_PER_SERIES);
    expect(calls.length).toBe(Math.ceil((181 * 24) / DD_MAX_POINTS_PER_SERIES));
  });

  it("fails rather than fold hours across midnight when Datadog widens the rollup", async () => {
    const from = Date.parse("2026-09-01T00:00:00Z");
    const { http } = makeHttp(() => timeseries(from, [{ values: [1, 2] }], 4 * HOUR));
    await expect(runDatadogMetricSource(ctxWith(http), params, range(), NOW)).rejects.toThrow(
      /widened the rollup to 14400s/,
    );
  });

  it("fails rather than return a short answer past the row cap", async () => {
    const from = Date.parse("2026-09-01T00:00:00Z");
    const { http } = makeHttp(() => timeseries(from, [{ values: Array<number>(24).fill(1) }]));
    await expect(
      runDatadogMetricSource(ctxWith(http), params, range({ maxRows: 10 }), NOW),
    ).rejects.toThrow(/more than 10 points/);
  });

  it("surfaces Datadog's own query error", async () => {
    const { http } = makeHttp(() => ({ body: { errors: "Error parsing query" } }));
    await expect(runDatadogMetricSource(ctxWith(http), params, range(), NOW)).rejects.toThrow(
      /Datadog rejected the query: Error parsing query/,
    );
  });
});
