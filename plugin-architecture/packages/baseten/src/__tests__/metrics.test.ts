import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BasetenApi } from "../api.js";
import { clampWindow, fetchModelMetrics, parseMetricsResponse } from "../metrics.js";
import { installFetch, route, state } from "./helpers.js";

beforeEach(() => installFetch());
afterEach(() => vi.unstubAllGlobals());

const response = {
  mode: "SERIES",
  step_seconds: 60,
  metric_descriptors: [
    { name: "baseten_replicas_active", unit_hint: "COUNT", kind: "GAUGE", label_sets: [{}] },
    {
      name: "baseten_end_to_end_response_time_seconds",
      unit_hint: "SECONDS",
      kind: "HISTOGRAM",
      label_sets: [{ quantile: "0.5" }, { quantile: "0.99" }, { stat: "avg" }],
    },
    {
      name: "baseten_inference_requests_total",
      unit_hint: "PER_SECOND",
      kind: "COUNTER",
      label_sets: [{ status: "2xx" }, { status: "5xx" }],
    },
    { name: "baseten_gpu_utilization", unit_hint: "RATIO", kind: "GAUGE", label_sets: [{}] },
  ],
  metric_values: [
    { start_epoch_millis: 1000, values: [[2], [0.1, 0.5, 0.2], [3, 1], [0.5]] },
    { start_epoch_millis: 2000, values: [[3], [0.2, null, 0.3], [4, 0], [null]] },
  ],
};

describe("parseMetricsResponse", () => {
  it("splits histograms by quantile and sums by-status counters", () => {
    const series = parseMetricsResponse(response);
    const by = Object.fromEntries(series.map((s) => [s.label, s]));
    expect(by["Active Replicas"]!.points.map((p) => p.value)).toEqual([2, 3]);
    expect(by["Latency p50"]!.points[0]).toEqual({ timestamp: 1000, value: 100 });
    expect(by["Latency p99"]!.points).toHaveLength(1);
    expect(by["Latency avg"]!.unit).toBe("ms");
    expect(by["Inference Requests"]!.points.map((p) => p.value)).toEqual([4, 4]);
    expect(by["Inference Requests (5xx)"]!.points.map((p) => p.value)).toEqual([1, 0]);
    expect(by["GPU Utilization"]!.points).toEqual([{ timestamp: 1000, value: 50 }]);
  });
});

describe("fetchModelMetrics", () => {
  it("requests a series with repeated metric names and caps the window at 7 days", async () => {
    route("GET", "/v1/models/m/deployments/d/metrics", response);
    const end = 30 * 86_400_000;
    await fetchModelMetrics(
      new BasetenApi("k", "", undefined),
      "/v1/models/m/deployments/d/metrics",
      {
        startMs: 0,
        endMs: end,
      },
    );
    const q = state.calls[0]!.query;
    expect(q.get("mode")).toBe("SERIES");
    expect(q.getAll("metrics")).toContain("baseten_gpu_utilization");
    expect(Number(q.get("start_epoch_millis"))).toBe(end - 7 * 86_400_000);
    expect(clampWindow({ startMs: 5, endMs: 10 })).toEqual({ startMs: 5, endMs: 10 });
  });

  it("retries with the default set when a metric name is rejected", async () => {
    let n = 0;
    route("GET", "/v1/models/m/deployments/d/metrics", () =>
      n++ === 0
        ? new Response(JSON.stringify({ detail: "unknown metric" }), { status: 400 })
        : response,
    );
    const series = await fetchModelMetrics(
      new BasetenApi("k", "", undefined),
      "/v1/models/m/deployments/d/metrics",
    );
    expect(state.calls[1]!.query.getAll("metrics")).toEqual([]);
    expect(series.length).toBeGreaterThan(0);
  });
});
