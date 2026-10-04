import { describe, expect, it } from "vitest";
import { infoSeries } from "../metrics.js";

describe("infoSeries", () => {
  it("turns an INFO reply into single-point series", () => {
    const series = infoSeries(
      {
        instantaneous_ops_per_sec: "250",
        connected_clients: "12",
        used_memory: String(64 * 1024 ** 2),
        maxmemory: String(256 * 1024 ** 2),
        evicted_keys: "3",
        keyspace_hits: "75",
        keyspace_misses: "25",
        db0: "keys=10,expires=0,avg_ttl=0",
        db1: "keys=5,expires=0,avg_ttl=0",
        cmdstat_get: "calls=300,usec=600,usec_per_call=2.00",
        cmdstat_set: "calls=100,usec=600,usec_per_call=6.00",
      },
      1000,
    );
    const byLabel = Object.fromEntries(series.map((s) => [s.label, s.points[0]!.value]));
    expect(byLabel).toMatchObject({
      "Ops/sec": 250,
      "Connected clients": 12,
      "Used memory": 64,
      "Memory used of maxmemory": 25,
      "Evicted keys (total)": 3,
      "Hit ratio": 75,
      Keys: 15,
      "Avg command latency (since restart)": 0.003,
    });
  });

  it("drops series for fields the server omits", () => {
    expect(infoSeries({ connected_clients: "1" }, 1).map((s) => s.label)).toEqual([
      "Connected clients",
    ]);
  });
});
