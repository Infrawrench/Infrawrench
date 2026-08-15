import { describe, it, expect } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { fetchDoMetricSeries, type DoMetricContext } from "../metric-series.js";

/**
 * These two branches shipped with no coverage and no way to see their output:
 * the resource types they serve declared `supportsMetrics` but their detail
 * views never declared `metricsCapability`, so the host fetched the series
 * into a page with no Metrics tab (issue #111). Now that the tab exists, pin
 * down what it will actually show.
 */

/** Prometheus-shaped `/v2/monitoring/metrics/*` payload. */
function prom(values: Array<[number, string]>) {
  return { data: { result: [{ values }] } };
}

function makeCtx(routes: Record<string, unknown>, seen?: string[]): DoMetricContext {
  return {
    async fetch<T>(path: string): Promise<T> {
      seen?.push(path);
      // Match on the path prefix before the query string, then let a fuller
      // key win so per-metric routes can be distinguished.
      const hit =
        routes[path] ??
        Object.entries(routes).find(([key]) => path.startsWith(key))?.[1] ??
        undefined;
      if (hit === undefined) throw new Error(`unrouted ${path}`);
      return hit as T;
    },
    async getResource(): Promise<ResourceInstance> {
      throw new Error("not used by these branches");
    },
  };
}

const RANGE = { startMs: 1_700_000_000_000, endMs: 1_700_003_600_000 };

describe("fetchDoMetricSeries — doks-cluster", () => {
  it("merges each metric across the cluster's node droplets", async () => {
    const routes: Record<string, unknown> = {
      "/kubernetes/clusters/k1": {
        kubernetes_cluster: {
          node_pools: [{ nodes: [{ droplet_id: 1 }, { droplet_id: 2 }] }],
        },
      },
      // CPU is a percentage: averaged. 20/40 → 30, 60/80 → 70.
      "/monitoring/metrics/droplet/cpu?host_id=1": prom([
        [1_700_000_000, "20"],
        [1_700_001_800, "60"],
      ]),
      "/monitoring/metrics/droplet/cpu?host_id=2": prom([
        [1_700_000_000, "40"],
        [1_700_001_800, "80"],
      ]),
      // Bytes: summed.
      "/monitoring/metrics/droplet/memory_free?host_id=1": prom([[1_700_000_000, "1000"]]),
      "/monitoring/metrics/droplet/memory_free?host_id=2": prom([[1_700_000_000, "2000"]]),
      "/monitoring/metrics/droplet/bandwidth?host_id=1": prom([[1_700_000_000, "5"]]),
      "/monitoring/metrics/droplet/bandwidth?host_id=2": prom([[1_700_000_000, "7"]]),
    };
    const series = await fetchDoMetricSeries(
      makeCtx(routes),
      "doks-cluster",
      "acc:doks-cluster:k1",
      "acc",
      RANGE,
    );

    expect(series.map((s) => s.label)).toEqual([
      "CPU Utilization (avg)",
      "Free Memory (sum)",
      "Network In (sum)",
    ]);
    expect(series[0]!.points).toEqual([
      { timestamp: 1_700_000_000_000, value: 30 },
      { timestamp: 1_700_001_800_000, value: 70 },
    ]);
    expect(series[1]!.points).toEqual([{ timestamp: 1_700_000_000_000, value: 3000 }]);
    expect(series[1]!.unit).toBe("bytes");
    expect(series[2]!.points).toEqual([{ timestamp: 1_700_000_000_000, value: 12 }]);
  });

  it("returns nothing rather than a zero line when the cluster has no nodes", async () => {
    const ctx = makeCtx({
      "/kubernetes/clusters/k1": { kubernetes_cluster: { node_pools: [] } },
    });
    await expect(
      fetchDoMetricSeries(ctx, "doks-cluster", "acc:doks-cluster:k1", "acc", RANGE),
    ).resolves.toEqual([]);
  });

  it("drops a metric no node reports instead of charting an empty series", async () => {
    const routes: Record<string, unknown> = {
      "/kubernetes/clusters/k1": {
        kubernetes_cluster: { node_pools: [{ nodes: [{ droplet_id: 1 }] }] },
      },
      "/monitoring/metrics/droplet/cpu?host_id=1": prom([[1_700_000_000, "10"]]),
      // memory_free and bandwidth are unrouted → the fetcher swallows and skips.
    };
    const series = await fetchDoMetricSeries(
      makeCtx(routes),
      "doks-cluster",
      "acc:doks-cluster:k1",
      "acc",
      RANGE,
    );
    expect(series.map((s) => s.label)).toEqual(["CPU Utilization (avg)"]);
  });
});

describe("fetchDoMetricSeries — gen-ai-agent", () => {
  const AGENT_ID = "acc:gen-ai-agent:11111111-2222-3333-4444-555555555555";

  it("charts the bucketed token counts plus the aggregate stats", async () => {
    const seen: string[] = [];
    const ctx = makeCtx(
      {
        "/gen-ai/agents/11111111-2222-3333-4444-555555555555/usage": {
          usage: {
            usage: [
              {
                start: "2026-08-11T00:00:00Z",
                end: "2026-08-11T01:00:00Z",
                tokens: 300,
                input_tokens: 200,
                output_tokens: 100,
              },
              {
                start: "2026-08-11T01:00:00Z",
                end: "2026-08-11T02:00:00Z",
                tokens: 60,
                input_tokens: 40,
                output_tokens: 20,
              },
            ],
            throughput_tokens_per_second: 12.5,
            latency_seconds: 0.8,
            time_to_first_token_seconds: 0.2,
          },
        },
      },
      seen,
    );

    const series = await fetchDoMetricSeries(ctx, "gen-ai-agent", AGENT_ID, "acc", RANGE);

    expect(series.map((s) => s.label)).toEqual([
      "Input tokens",
      "Output tokens",
      "Total tokens",
      "Throughput",
      "Latency (avg)",
      "Time to first token (avg)",
    ]);
    // The window start is the x-coordinate, and the requested range reaches
    // the provider as ISO `start`/`stop`.
    expect(series[0]!.points).toEqual([
      { timestamp: Date.parse("2026-08-11T00:00:00Z"), value: 200 },
      { timestamp: Date.parse("2026-08-11T01:00:00Z"), value: 40 },
    ]);
    expect(series[2]!.points.map((p) => p.value)).toEqual([300, 60]);
    expect(series[3]!.points).toHaveLength(1);
    expect(series[3]!.unit).toBe("tokens/s");
    expect(seen[0]).toContain(`start=${encodeURIComponent(new Date(RANGE.startMs).toISOString())}`);
    expect(seen[0]).toContain(`stop=${encodeURIComponent(new Date(RANGE.endMs).toISOString())}`);
  });

  it("falls back to the flat totals when the provider returns no buckets", async () => {
    const ctx = makeCtx({
      "/gen-ai/agents/11111111-2222-3333-4444-555555555555/usage": {
        usage: {
          usage: [],
          total_input_tokens: 900,
          total_output_tokens: 100,
          total_tokens: 1000,
        },
      },
    });
    const series = await fetchDoMetricSeries(ctx, "gen-ai-agent", AGENT_ID, "acc", RANGE);
    expect(series.map((s) => s.label)).toEqual([
      "Total input tokens",
      "Total output tokens",
      "Total tokens",
    ]);
    expect(series.every((s) => s.points.length === 1)).toBe(true);
  });

  it("treats a 404 from an agent that has never run as an empty tab, not an error", async () => {
    const ctx = makeCtx({});
    await expect(fetchDoMetricSeries(ctx, "gen-ai-agent", AGENT_ID, "acc", RANGE)).resolves.toEqual(
      [],
    );
  });
});
