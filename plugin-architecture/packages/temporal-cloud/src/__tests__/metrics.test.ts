import { beforeEach, describe, expect, it } from "vitest";
import { clearMetricsCache, namespaceSeries, parseOpenMetrics, scrapeMetrics } from "../metrics.js";
import { ctxWith, makeHttp } from "./helpers.js";

const BODY = `# TYPE temporal_cloud_v1_workflow_success_count gauge
# HELP temporal_cloud_v1_workflow_success_count The number of successful workflows per second
temporal_cloud_v1_workflow_success_count{temporal_namespace="production",temporal_workflow_type="pay",region="aws-us-west-2"} 42.0 1609459200000
temporal_cloud_v1_workflow_success_count{temporal_namespace="production",temporal_workflow_type="ship",region="aws-us-west-2"} 8 1609459200000
temporal_cloud_v1_workflow_success_count{temporal_namespace="staging",temporal_workflow_type="pay"} 1 1609459200000
temporal_cloud_v1_service_latency_p95{temporal_namespace="production",operation="StartWorkflowExecution"} 0.12 1609459200
temporal_cloud_v1_service_latency_p95{temporal_namespace="production",operation="PollWorkflowTaskQueue"} 0.3 1609459200
# EOF
`;

describe("parseOpenMetrics", () => {
  it("parses labels, values and either timestamp unit", () => {
    const samples = parseOpenMetrics(BODY);
    expect(samples).toHaveLength(5);
    expect(samples[0]).toMatchObject({
      name: "temporal_cloud_v1_workflow_success_count",
      labels: { temporal_namespace: "production", temporal_workflow_type: "pay" },
      value: 42,
      timestampMs: 1609459200000,
    });
    expect(samples[3]?.timestampMs).toBe(1609459200000);
  });
});

describe("namespaceSeries", () => {
  it("sums rates and takes the worst percentile, matching name or full id", () => {
    const series = namespaceSeries(parseOpenMetrics(BODY), "production.a2dd6");
    const by = (l: string) => series.find((s) => s.label.startsWith(l));
    expect(by("Workflows succeeded/s")?.points[0]?.value).toBe(50);
    expect(by("Service latency p95")?.points[0]?.value).toBeCloseTo(300);
    expect(by("Service latency p95")?.unit).toBe("ms");
    expect(by("Actions/s")).toBeUndefined();
  });
});

describe("scrapeMetrics", () => {
  beforeEach(() => clearMetricsCache());

  it("scrapes once per minute for every namespace with the metrics key", async () => {
    const { http, calls } = makeHttp(() => ({ text: BODY }));
    const ctx = ctxWith(http);
    await scrapeMetrics(ctx);
    await scrapeMetrics(ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.host).toBe("metrics.temporal.io");
    expect(calls[0]?.headers["Authorization"]).toBe("Bearer metrics-key");
    expect(calls[0]?.url.searchParams.getAll("metrics")).toContain(
      "temporal_cloud_v1_total_action_count",
    );
    expect(calls[0]?.url.searchParams.get("namespaces")).toBeNull();
  });

  it("explains a refused key", async () => {
    const { http } = makeHttp(() => ({ status: 403, text: "forbidden" }));
    await expect(scrapeMetrics(ctxWith(http))).rejects.toThrow(/Metrics Read-Only/);
  });
});
