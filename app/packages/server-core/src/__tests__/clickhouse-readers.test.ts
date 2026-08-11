import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClickHouse } from "./helpers/fake-clickhouse";

/**
 * The readers run against a real Drizzle database over a fake driver, so the
 * SQL these assertions see is the SQL ClickHouse would get. Rows are given as
 * objects whose keys are written **in each query's projection order** — see
 * `helpers/fake-clickhouse.ts`.
 */
const ch = fakeClickHouse();
const isConfigured = vi.fn(() => true);
vi.mock("../clickhouse/client", () => ({
  isClickHouseConfigured: () => isConfigured(),
  getClickHouseDb: () => ch.db,
  getClickHouseClient: () => ch.client,
}));

let readers: typeof import("../clickhouse/readers");

beforeEach(async () => {
  vi.clearAllMocks();
  ch.reset();
  isConfigured.mockReturnValue(true);
  readers = await import("../clickhouse/readers");
});

describe("guard: not configured", () => {
  it("getLatestStats returns null", async () => {
    isConfigured.mockReturnValue(false);
    expect(await readers.getLatestStats("o", "r")).toBeNull();
    expect(ch.queries).toEqual([]);
  });

  it("getLatestMetricsBatch returns an empty map", async () => {
    isConfigured.mockReturnValue(false);
    const out = await readers.getLatestMetricsBatch("o", ["r"]);
    expect(out.size).toBe(0);
  });
});

describe("getLatestStats", () => {
  it("parses the stats_json of the newest row", async () => {
    ch.setRows([{ stats_json: JSON.stringify([{ label: "L", value: "1" }]) }]);
    const out = await readers.getLatestStats("o", "r");
    expect(out).toEqual([{ label: "L", value: "1" }]);
  });

  it("returns null when no rows", async () => {
    ch.setRows([]);
    expect(await readers.getLatestStats("o", "r")).toBeNull();
  });

  it("returns null on malformed JSON", async () => {
    ch.setRows([{ stats_json: "{not json" }]);
    expect(await readers.getLatestStats("o", "r")).toBeNull();
  });

  it("propagates a failing query instead of reading as 'no data'", async () => {
    vi.spyOn(ch.client, "query").mockRejectedValueOnce(new Error("boom"));
    // Drizzle re-throws with the statement attached; the driver's error is the
    // cause. What matters is that it throws at all rather than answering "this
    // resource has no data", which is how an outage renders as an empty chart.
    const failure = await readers.getLatestStats("o", "r").catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as { cause?: unknown }).cause).toMatchObject({ message: "boom" });
  });
});

describe("getLatestMetrics", () => {
  it("groups rows back into per-series shape", async () => {
    ch.setRows([
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

  it("returns null when no rows", async () => {
    ch.setRows([]);
    expect(await readers.getLatestMetrics("o", "r")).toBeNull();
  });
});

describe("getLatestMetricsBatch", () => {
  it("returns empty map for empty ids without querying", async () => {
    const out = await readers.getLatestMetricsBatch("o", []);
    expect(out.size).toBe(0);
    expect(ch.queries).toEqual([]);
  });

  it("keys series by resource id", async () => {
    ch.setRows([
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
  it("parses each row, skipping malformed ones", async () => {
    ch.setRows([
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
    expect(ch.queries).toEqual([]);
  });
});

describe("getLatestAccountCounts", () => {
  it("parses the newest counts_json", async () => {
    ch.setRows([{ counts_json: JSON.stringify([{ typeLabel: "VMs", count: 2 }]) }]);
    expect(await readers.getLatestAccountCounts("o", "a")).toEqual([
      { typeLabel: "VMs", count: 2 },
    ]);
  });

  it("null on no rows and on malformed json", async () => {
    ch.setRows([]);
    expect(await readers.getLatestAccountCounts("o", "a")).toBeNull();
    ch.setRows([{ counts_json: "x" }]);
    expect(await readers.getLatestAccountCounts("o", "a")).toBeNull();
  });
});

describe("getLatestAccountCountsBatch", () => {
  it("maps account ids, skipping malformed", async () => {
    ch.setRows([
      { account_id: "a1", counts_json: JSON.stringify([{ typeLabel: "X", count: 1 }]) },
      { account_id: "a2", counts_json: "nope" },
    ]);
    const out = await readers.getLatestAccountCountsBatch("o", ["a1", "a2"]);
    expect(out.get("a1")).toEqual([{ typeLabel: "X", count: 1 }]);
    expect(out.has("a2")).toBe(false);
  });

  it("empty ids → empty map", async () => {
    const out = await readers.getLatestAccountCountsBatch("o", []);
    expect(out.size).toBe(0);
  });
});

describe("getMetricRange", () => {
  function withRows() {
    ch.setRows([
      { series_label: "cpu", unit: "%", ts_ms: 0, value: 1 },
      { series_label: "cpu", unit: "%", ts_ms: 1000, value: 2 },
    ]);
  }

  it("uses metric_points_raw for spans <= 2h", async () => {
    withRows();
    await readers.getMetricRange("o", "r", 0, 60 * 60 * 1000); // 1h
    expect(ch.lastQuery()).toContain("metric_points_raw");
  });

  it("uses the 1m rollup for spans <= 7d", async () => {
    withRows();
    const from = 0;
    const to = 3 * 24 * 60 * 60 * 1000; // 3d
    await readers.getMetricRange("o", "r", from, to);
    expect(ch.lastQuery()).toContain("metric_points_1m");
  });

  it("uses the 1h rollup for spans > 7d", async () => {
    withRows();
    const from = 0;
    const to = 30 * 24 * 60 * 60 * 1000; // 30d
    await readers.getMetricRange("o", "r", from, to);
    expect(ch.lastQuery()).toContain("metric_points_1h");
  });

  it("groups returned rows by series", async () => {
    withRows();
    const out = await readers.getMetricRange("o", "r", 0, 1000);
    expect(out).toHaveLength(1);
    expect(out[0]!.label).toBe("cpu");
    expect(out[0]!.points).toHaveLength(2);
  });

  it("returns [] when not configured", async () => {
    isConfigured.mockReturnValue(false);
    expect(await readers.getMetricRange("o", "r", 0, 1000)).toEqual([]);
  });
});

describe("getMetricQuantilesBatch", () => {
  it("returns an empty map for an empty id list without querying", async () => {
    const out = await readers.getMetricQuantilesBatch("o", [], 0, 1000);
    expect(out.size).toBe(0);
    expect(ch.queries).toEqual([]);
  });

  it("reads the 1m rollup and groups quantiles per resource", async () => {
    ch.setRows([
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
    expect(ch.lastQuery()).toContain("metric_points_1m");
    expect(ch.lastQuery()).toContain("quantile(0.05)");
    expect(out.get("r1")).toEqual([
      { label: "CPU Utilization", unit: "%", q05: 1, q95: 12.5, max: 40, samples: 20160 },
      { label: "Memory Available", unit: "bytes", q05: 1024, q95: 4096, max: 8192, samples: 20160 },
    ]);
    expect(out.get("r2")).toHaveLength(1);
  });

  it("returns an empty map when not configured", async () => {
    isConfigured.mockReturnValue(false);
    const out = await readers.getMetricQuantilesBatch("o", ["r1"], 0, 1000);
    expect(out.size).toBe(0);
  });
});
