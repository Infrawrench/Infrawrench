import { beforeEach, describe, expect, it, vi } from "vitest";

const json = vi.fn();
const query = vi.fn(async (_opts?: unknown) => ({ json }));
const isConfigured = vi.fn(() => true);
vi.mock("../clickhouse/client", () => ({
  isClickHouseConfigured: () => isConfigured(),
  getClickHouseClient: () => ({ query }),
}));

let readers: typeof import("../clickhouse/readers");

beforeEach(async () => {
  vi.clearAllMocks();
  isConfigured.mockReturnValue(true);
  readers = await import("../clickhouse/readers");
});

describe("guard: not configured", () => {
  it("getLatestStats returns null", async () => {
    isConfigured.mockReturnValue(false);
    expect(await readers.getLatestStats("o", "r")).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it("getLatestMetricsBatch returns an empty map", async () => {
    isConfigured.mockReturnValue(false);
    const out = await readers.getLatestMetricsBatch("o", ["r"]);
    expect(out.size).toBe(0);
  });
});

describe("getLatestStats", () => {
  it("parses the stats_json of the newest row", async () => {
    json.mockResolvedValue([{ stats_json: JSON.stringify([{ label: "L", value: "1" }]) }]);
    const out = await readers.getLatestStats("o", "r");
    expect(out).toEqual([{ label: "L", value: "1" }]);
  });

  it("returns null when no rows", async () => {
    json.mockResolvedValue([]);
    expect(await readers.getLatestStats("o", "r")).toBeNull();
  });

  it("returns null on malformed JSON", async () => {
    json.mockResolvedValue([{ stats_json: "{not json" }]);
    expect(await readers.getLatestStats("o", "r")).toBeNull();
  });

  it("returns [] (swallows) when the query throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    query.mockRejectedValueOnce(new Error("boom"));
    expect(await readers.getLatestStats("o", "r")).toBeNull();
    expect(spy).toHaveBeenCalled();
  });
});

describe("getLatestMetrics", () => {
  it("groups rows back into per-series shape", async () => {
    json.mockResolvedValue([
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
    json.mockResolvedValue([]);
    expect(await readers.getLatestMetrics("o", "r")).toBeNull();
  });
});

describe("getLatestMetricsBatch", () => {
  it("returns empty map for empty ids without querying", async () => {
    const out = await readers.getLatestMetricsBatch("o", []);
    expect(out.size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it("keys series by resource id", async () => {
    json.mockResolvedValue([
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
    json.mockResolvedValue([
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
    expect(query).not.toHaveBeenCalled();
  });
});

describe("getLatestAccountCounts", () => {
  it("parses the newest counts_json", async () => {
    json.mockResolvedValue([{ counts_json: JSON.stringify([{ typeLabel: "VMs", count: 2 }]) }]);
    expect(await readers.getLatestAccountCounts("o", "a")).toEqual([
      { typeLabel: "VMs", count: 2 },
    ]);
  });

  it("null on no rows and on malformed json", async () => {
    json.mockResolvedValueOnce([]);
    expect(await readers.getLatestAccountCounts("o", "a")).toBeNull();
    json.mockResolvedValueOnce([{ counts_json: "x" }]);
    expect(await readers.getLatestAccountCounts("o", "a")).toBeNull();
  });
});

describe("getLatestAccountCountsBatch", () => {
  it("maps account ids, skipping malformed", async () => {
    json.mockResolvedValue([
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
    json.mockResolvedValue([
      { series_label: "cpu", unit: "%", ts_ms: 0, value: 1 },
      { series_label: "cpu", unit: "%", ts_ms: 1000, value: 2 },
    ]);
  }

  it("uses metric_points_raw for spans <= 2h", async () => {
    withRows();
    await readers.getMetricRange("o", "r", 0, 60 * 60 * 1000); // 1h
    const q = query.mock.calls[0]![0] as { query: string };
    expect(q.query).toContain("metric_points_raw");
  });

  it("uses the 1m rollup for spans <= 7d", async () => {
    withRows();
    const from = 0;
    const to = 3 * 24 * 60 * 60 * 1000; // 3d
    await readers.getMetricRange("o", "r", from, to);
    const q = query.mock.calls[0]![0] as { query: string };
    expect(q.query).toContain("metric_points_1m");
  });

  it("uses the 1h rollup for spans > 7d", async () => {
    withRows();
    const from = 0;
    const to = 30 * 24 * 60 * 60 * 1000; // 30d
    await readers.getMetricRange("o", "r", from, to);
    const q = query.mock.calls[0]![0] as { query: string };
    expect(q.query).toContain("metric_points_1h");
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
