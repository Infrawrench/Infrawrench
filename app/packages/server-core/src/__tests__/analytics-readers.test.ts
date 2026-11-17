import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakePostgres } from "./helpers/fake-postgres";

/**
 * The readers run against a real Drizzle database over a recording driver, so
 * the SQL these assertions see is the SQL Postgres would get. Rows are given
 * as objects whose keys are written **in each query's projection order**: see
 * `helpers/fake-postgres.ts`. `db/analytics.test.ts` runs the same readers
 * against a real server.
 */
const pg = fakePostgres();
vi.mock("../analytics/client", () => ({ getAnalyticsDb: () => pg.db }));

const readers = await import("../analytics/readers");

beforeEach(() => {
  vi.clearAllMocks();
  pg.reset();
});

describe("getLatestStats", () => {
  it("parses the stats_json of the newest row", async () => {
    pg.setRows([{ stats_json: JSON.stringify([{ label: "L", value: "1" }]) }]);
    const out = await readers.getLatestStats("o", "r");
    expect(out).toEqual([{ label: "L", value: "1" }]);
    expect(pg.lastQuery().sql).toContain('order by "dashboard_stats"."ts" desc limit');
  });

  it("returns null when no rows", async () => {
    pg.setRows([]);
    expect(await readers.getLatestStats("o", "r")).toBeNull();
  });

  it("returns null on malformed JSON", async () => {
    pg.setRows([{ stats_json: "{not json" }]);
    expect(await readers.getLatestStats("o", "r")).toBeNull();
  });

  it("propagates a failing query instead of reading as 'no data'", async () => {
    // A null row makes the decode throw, which stands in for a driver error.
    // What matters is that it throws at all rather than answering "this
    // resource has no data", which is how an outage renders as an empty chart.
    pg.queueRows([null as never]);
    await expect(readers.getLatestStats("o", "r")).rejects.toBeInstanceOf(Error);
  });
});

describe("getLatestMetrics", () => {
  it("groups rows back into per-series shape", async () => {
    pg.setRows([
      { series_label: "cpu", unit: "%", ts_ms: 0, value: 1 },
      { series_label: "cpu", unit: "%", ts_ms: 1000, value: 2 },
      { series_label: "mem", unit: "", ts_ms: 0, value: 9 },
    ]);
    const out = await readers.getLatestMetrics("o", "r");
    expect(out).not.toBeNull();
    expect(out).toHaveLength(2);
    const cpu = out!.find((s) => s.label === "cpu")!;
    expect(cpu.unit).toBe("%");
    expect(cpu.points).toEqual([
      { timestamp: 0, value: 1 },
      { timestamp: 1000, value: 2 },
    ]);
    const mem = out!.find((s) => s.label === "mem")!;
    expect(mem.unit).toBeUndefined(); // empty unit omitted
  });

  it("reads the last hour of raw points with millisecond timestamps", async () => {
    pg.setRows([]);
    await readers.getLatestMetrics("o", "r");
    const { sql } = pg.lastQuery();
    expect(sql).toContain('from "metric_points_raw"');
    expect(sql).toContain("now() - interval '1 hour'");
    expect(sql).toContain("(extract(epoch from");
  });

  it("returns null when no rows", async () => {
    pg.setRows([]);
    expect(await readers.getLatestMetrics("o", "r")).toBeNull();
  });
});

describe("getLatestMetricsBatch", () => {
  it("returns empty map for empty ids without querying", async () => {
    const out = await readers.getLatestMetricsBatch("o", []);
    expect(out.size).toBe(0);
    expect(pg.queries).toEqual([]);
  });

  it("keys series by resource id", async () => {
    pg.setRows([
      { resource_id: "r1", series_label: "cpu", unit: "%", ts_ms: 0, value: 1 },
      { resource_id: "r1", series_label: "cpu", unit: "%", ts_ms: 1, value: 2 },
      { resource_id: "r2", series_label: "io", unit: "", ts_ms: 0, value: 3 },
    ]);
    const out = await readers.getLatestMetricsBatch("o", ["r1", "r2"]);
    expect(out.get("r1")![0]!.points).toHaveLength(2);
    expect(out.get("r2")![0]!.label).toBe("io");
  });
});

describe("getLatestStatsBatch", () => {
  it("takes the newest snapshot per resource", async () => {
    pg.setRows([]);
    await readers.getLatestStatsBatch("o", ["r1", "r2"]);
    const { sql } = pg.lastQuery();
    expect(sql).toContain('select distinct on ("dashboard_stats"."resource_id")');
    expect(sql).toContain(
      'order by "dashboard_stats"."resource_id" asc, "dashboard_stats"."ts" desc',
    );
  });

  it("parses each row, skipping malformed ones", async () => {
    pg.setRows([
      { resource_id: "r1", stats_json: JSON.stringify([{ label: "A", value: "1" }]) },
      { resource_id: "r2", stats_json: "broken" },
    ]);
    const out = await readers.getLatestStatsBatch("o", ["r1", "r2"]);
    expect(out.get("r1")).toEqual([{ label: "A", value: "1" }]);
    expect(out.has("r2")).toBe(false);
  });

  it("empty ids → empty map, no query", async () => {
    const out = await readers.getLatestStatsBatch("o", []);
    expect(out.size).toBe(0);
    expect(pg.queries).toEqual([]);
  });
});

describe("getLatestAccountCounts", () => {
  it("parses the newest counts_json", async () => {
    pg.setRows([{ counts_json: JSON.stringify([{ typeLabel: "VMs", count: 2 }]) }]);
    expect(await readers.getLatestAccountCounts("o", "a")).toEqual([
      { typeLabel: "VMs", count: 2 },
    ]);
  });

  it("null on no rows and on malformed json", async () => {
    pg.setRows([]);
    expect(await readers.getLatestAccountCounts("o", "a")).toBeNull();
    pg.setRows([{ counts_json: "x" }]);
    expect(await readers.getLatestAccountCounts("o", "a")).toBeNull();
  });
});

describe("getLatestAccountCountsBatch", () => {
  it("maps account ids, skipping malformed", async () => {
    pg.setRows([
      { account_id: "a1", counts_json: JSON.stringify([{ typeLabel: "X", count: 1 }]) },
      { account_id: "a2", counts_json: "nope" },
    ]);
    const out = await readers.getLatestAccountCountsBatch("o", ["a1", "a2"]);
    expect(out.get("a1")).toEqual([{ typeLabel: "X", count: 1 }]);
    expect(out.has("a2")).toBe(false);
    expect(pg.lastQuery().sql).toContain(
      'select distinct on ("account_resource_counts"."account_id")',
    );
  });

  it("empty ids → empty map", async () => {
    const out = await readers.getLatestAccountCountsBatch("o", []);
    expect(out.size).toBe(0);
  });
});

describe("getMetricRange", () => {
  function withRows() {
    pg.setRows([
      { series_label: "cpu", unit: "%", ts_ms: 0, value: 1 },
      { series_label: "cpu", unit: "%", ts_ms: 1000, value: 2 },
    ]);
  }

  it("uses metric_points_raw for spans <= 2h", async () => {
    withRows();
    await readers.getMetricRange("o", "r", 0, 60 * 60 * 1000); // 1h
    const { sql, params } = pg.lastQuery();
    expect(sql).toContain('from "metric_points_raw"');
    // Millisecond bounds on the raw table.
    expect(params).toContain(new Date(0).toISOString());
    expect(params).toContain(new Date(60 * 60 * 1000).toISOString());
  });

  it("uses the 1m rollup's sum/count average for spans <= 7d", async () => {
    withRows();
    await readers.getMetricRange("o", "r", 0, 3 * 24 * 60 * 60 * 1000); // 3d
    const { sql } = pg.lastQuery();
    expect(sql).toContain('from "metric_points_1m"');
    expect(sql).toMatch(/"value_sum" \/ nullif\(("metric_points_1m"\.)?"value_count", 0\)/);
  });

  it("uses the 1h rollup for spans > 7d", async () => {
    withRows();
    await readers.getMetricRange("o", "r", 0, 30 * 24 * 60 * 60 * 1000); // 30d
    expect(pg.lastQuery().sql).toContain('from "metric_points_1h"');
  });

  it("floors rollup bounds to the second", async () => {
    withRows();
    await readers.getMetricRange("o", "r", 1_500, 3 * 24 * 60 * 60 * 1000 + 999);
    const { params } = pg.lastQuery();
    expect(params).toContain(new Date(1_000).toISOString());
    expect(params).toContain(new Date(3 * 24 * 60 * 60 * 1000).toISOString());
  });

  it("groups returned rows by series", async () => {
    withRows();
    const out = await readers.getMetricRange("o", "r", 0, 1000);
    expect(out).toHaveLength(1);
    expect(out[0]!.label).toBe("cpu");
    expect(out[0]!.points).toHaveLength(2);
  });
});

describe("getMetricQuantilesBatch", () => {
  it("returns an empty map for an empty id list without querying", async () => {
    const out = await readers.getMetricQuantilesBatch("o", [], 0, 1000);
    expect(out.size).toBe(0);
    expect(pg.queries).toEqual([]);
  });

  it("reads the 1m rollup and groups quantiles per resource", async () => {
    pg.setRows([
      {
        resource_id: "r1",
        series_label: "CPU Utilization",
        unit: "%",
        q05: 1,
        q95: 12.5,
        vmax: 40,
        samples: "20160",
      },
      {
        resource_id: "r1",
        series_label: "Memory Available",
        unit: "bytes",
        q05: 1024,
        q95: 4096,
        vmax: 8192,
        samples: 20160,
      },
      {
        resource_id: "r2",
        series_label: "CPU Utilization",
        unit: "%",
        q05: 0.5,
        q95: 90,
        vmax: 100,
        samples: 100,
      },
    ]);
    const out = await readers.getMetricQuantilesBatch("o", ["r1", "r2"], 0, 1000);
    const { sql } = pg.lastQuery();
    expect(sql).toContain('from "metric_points_1m"');
    expect(sql).toContain("percentile_cont(0.05) WITHIN GROUP (ORDER BY");
    expect(sql).toContain("percentile_cont(0.95) WITHIN GROUP (ORDER BY");
    expect(out.get("r1")).toEqual([
      { label: "CPU Utilization", unit: "%", q05: 1, q95: 12.5, max: 40, samples: 20160 },
      { label: "Memory Available", unit: "bytes", q05: 1024, q95: 4096, max: 8192, samples: 20160 },
    ]);
    expect(out.get("r2")).toHaveLength(1);
  });
});

describe("listMetricSeriesKeys", () => {
  it("counts distinct resources per series over the last week, narrowed by plugin", async () => {
    pg.setRows([{ series_label: "CPU", unit: "%", resource_count: "3" }]);
    expect(await readers.listMetricSeriesKeys("o", { pluginId: "aws" })).toEqual([
      { label: "CPU", unit: "%", resourceCount: 3 },
    ]);
    const { sql, params } = pg.lastQuery();
    expect(sql).toMatch(/count\(DISTINCT ("metric_points_raw"\.)?"resource_id"\)/);
    expect(sql).toContain("now() - interval '7 days'");
    expect(params).toContain("aws");
  });
});

describe("getMetricDailyAverageBatch", () => {
  it("averages hourly rollup averages per UTC day", async () => {
    pg.setRows([{ resource_id: "r1", day: "2026-11-01", value: "0.5" }]);
    expect(await readers.getMetricDailyAverageBatch("o", ["r1"], "Up", 0, 1000)).toEqual([
      { resourceId: "r1", day: "2026-11-01", value: 0.5 },
    ]);
    const { sql } = pg.lastQuery();
    expect(sql).toContain('from "metric_points_1h"');
    expect(sql).toContain("AT TIME ZONE 'UTC', 'YYYY-MM-DD')");
  });
});
