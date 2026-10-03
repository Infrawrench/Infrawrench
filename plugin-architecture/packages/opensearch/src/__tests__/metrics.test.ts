import { describe, expect, it } from "vitest";
import { nodeStatsSeries, type NodeInfo } from "../client.js";

const NODES: NodeInfo[] = [
  {
    name: "a",
    os: { cpu: { load_average: { "1m": 1 } }, mem: { used_percent: 40 } },
    indices: {
      search: { query_total: 10, query_time_in_millis: 50 },
      indexing: { index_total: 0, index_time_in_millis: 0 },
      segments: { count: 12 },
      query_cache: { memory_size_in_bytes: 1024, evictions: 2 },
    },
    jvm: { gc: { collectors: { old: { collection_count: 1, collection_time_in_millis: 30 } } } },
    thread_pool: { search: { queue: 3, rejected: 1 }, write: { queue: 0, rejected: 4 } },
    http: { current_open: 5 },
    breakers: { parent: { tripped: 1 }, fielddata: { tripped: 2 } },
    transport: { rx_size_in_bytes: 100, tx_size_in_bytes: 200 },
  },
  {
    name: "b",
    os: { cpu: { load_average: { "1m": 3 } }, mem: { used_percent: 60 } },
    indices: { search: { query_total: 30, query_time_in_millis: 150 } },
    thread_pool: { search: { queue: 1, rejected: 0 } },
    http: { current_open: 7 },
  },
];

describe("nodeStatsSeries", () => {
  const byLabel = Object.fromEntries(nodeStatsSeries(NODES, 1).map((s) => [s.label, s]));
  const value = (label: string) => byLabel[label]?.points[0]?.value;

  it("averages gauges and sums counters across nodes", () => {
    expect(value("Avg OS memory used %")).toBe(50);
    expect(value("Avg load (1m)")).toBe(2);
    expect(value("Search queue")).toBe(4);
    expect(value("Search rejections (cumulative)")).toBe(1);
    expect(value("Write rejections (cumulative)")).toBe(4);
    expect(value("Open HTTP connections")).toBe(12);
    expect(value("Circuit breaker trips (cumulative)")).toBe(3);
    expect(value("Old GC time (cumulative)")).toBe(30);
  });

  it("derives per-operation latency and skips it with no operations", () => {
    expect(byLabel["Avg search query latency (lifetime)"]).toMatchObject({
      unit: "ms",
      points: [{ value: 5 }],
    });
    expect(byLabel["Avg indexing latency (lifetime)"]).toBeUndefined();
  });

  it("reports byte series raw and drops groups no node returned", () => {
    expect(byLabel["Query cache size"]).toMatchObject({ unit: "bytes", points: [{ value: 1024 }] });
    expect(byLabel["Transport sent (cumulative)"]).toMatchObject({ unit: "bytes" });
    expect(byLabel["Fielddata size"]).toBeUndefined();
    expect(byLabel["Running merges"]).toBeUndefined();
  });
});
