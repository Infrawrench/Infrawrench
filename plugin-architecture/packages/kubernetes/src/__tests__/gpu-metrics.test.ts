import { describe, it, expect } from "vitest";

import {
  discoverPrometheus,
  fetchGpuUtilization,
  parseExposition,
  parseGpuMetricsSetting,
} from "../gpu-metrics.js";
import type { K8sPod, K8sService } from "../types.js";

function svc(
  name: string,
  namespace: string,
  ports: Array<{ port: number; name?: string }>,
  labels = {},
): K8sService {
  return {
    metadata: { name, namespace, uid: name, creationTimestamp: "", labels },
    spec: {
      type: "ClusterIP",
      ports: ports.map((p) => ({ ...p, targetPort: p.port, protocol: "TCP" })),
    },
  };
}

describe("parseGpuMetricsSetting", () => {
  it("parses a Service reference, a path prefix, and the off switch", () => {
    expect(parseGpuMetricsSetting("monitoring/prometheus-operated:9090")).toEqual({
      namespace: "monitoring",
      service: "prometheus-operated",
      port: "9090",
      prefix: "",
    });
    expect(parseGpuMetricsSetting("obs/thanos-query:http/prom/")).toMatchObject({
      port: "http",
      prefix: "/prom",
    });
    expect(parseGpuMetricsSetting("none")).toBe("disabled");
    expect(parseGpuMetricsSetting("")).toBeNull();
    expect(parseGpuMetricsSetting("not a ref")).toBeNull();
  });
});

describe("discoverPrometheus", () => {
  it("prefers the operator's Service and ignores look-alikes", () => {
    const targets = discoverPrometheus([
      svc("alertmanager-operated", "monitoring", [{ port: 9093, name: "web" }]),
      svc("prometheus-server", "observability", [{ port: 80, name: "http" }]),
      svc("prometheus-operated", "monitoring", [{ port: 9090, name: "web" }]),
      svc("kube-prometheus-stack-operator", "monitoring", [{ port: 443 }]),
    ]);
    expect(targets.map((t) => `${t.namespace}/${t.service}:${t.port}`)).toEqual([
      "monitoring/prometheus-operated:web",
      "observability/prometheus-server:http",
    ]);
  });
});

describe("parseExposition", () => {
  it("reads labelled samples and skips comments and unwanted metrics", () => {
    const text = [
      "# HELP DCGM_FI_DEV_GPU_UTIL GPU utilization (in %).",
      "# TYPE DCGM_FI_DEV_GPU_UTIL gauge",
      'DCGM_FI_DEV_GPU_UTIL{gpu="0",UUID="GPU-a",modelName="NVIDIA A100",pod="train-0",namespace="ml",container="c"} 37',
      'DCGM_FI_DEV_SM_CLOCK{gpu="0"} 1410',
      'DCGM_FI_DEV_FB_USED{gpu="0",UUID="GPU-a",pod="train-0",namespace="ml"} 2048 1712345678000',
    ].join("\n");
    const parsed = parseExposition(text, new Set(["DCGM_FI_DEV_GPU_UTIL", "DCGM_FI_DEV_FB_USED"]));
    expect(parsed.get("DCGM_FI_DEV_GPU_UTIL")).toEqual([
      {
        labels: {
          gpu: "0",
          UUID: "GPU-a",
          modelName: "NVIDIA A100",
          pod: "train-0",
          namespace: "ml",
          container: "c",
        },
        value: 37,
      },
    ]);
    expect(parsed.get("DCGM_FI_DEV_FB_USED")?.[0]?.value).toBe(2048);
    expect(parsed.has("DCGM_FI_DEV_SM_CLOCK")).toBe(false);
  });
});

/** A fake API server that answers proxied Prometheus queries from a table. */
function fakePrometheus(
  answers: Record<string, Array<{ metric: Record<string, string>; value: number }>>,
) {
  const seen: string[] = [];
  const fetch = async <T>(path: string): Promise<T> => {
    seen.push(path);
    const query = decodeURIComponent(path.split("query=")[1] ?? "");
    const result = (answers[query] ?? []).map((r) => ({
      metric: r.metric,
      value: [0, String(r.value)],
    }));
    return { status: "success", data: { resultType: "vector", result } } as T;
  };
  return { fetch, seen };
}

describe("fetchGpuUtilization", () => {
  const services = [svc("prometheus-operated", "monitoring", [{ port: 9090, name: "web" }])];

  it("reads utilization and history through the Prometheus proxy, preferring exported_ labels", async () => {
    const device = {
      UUID: "GPU-a",
      gpu: "0",
      namespace: "gpu-operator",
      pod: "nvidia-dcgm-exporter-x",
      exported_namespace: "ml",
      exported_pod: "train-0",
    };
    const { fetch, seen } = fakePrometheus({
      "avg_over_time(DCGM_FI_DEV_GPU_UTIL[1h])": [{ metric: device, value: 40 }],
      "avg_over_time(DCGM_FI_DEV_FB_USED[1h])": [{ metric: device, value: 3000 }],
      "quantile_over_time(0.95, DCGM_FI_DEV_GPU_UTIL[7d])": [{ metric: device, value: 55 }],
      "max_over_time(DCGM_FI_DEV_FB_USED[7d])": [{ metric: device, value: 5000 }],
    });
    const result = await fetchGpuUtilization(fetch, { setting: undefined, services, pods: [] });
    expect(result.source).toEqual({
      kind: "prometheus",
      target: "monitoring/prometheus-operated:web",
      history: true,
    });
    expect(result.pods.get("ml/train-0")).toEqual({
      utilization: 0.4,
      memoryUsedMiB: 3000,
      p95Utilization: 0.55,
      peakMemoryMiB: 5000,
      devices: 1,
    });
    expect(seen[0]).toContain(
      "/api/v1/namespaces/monitoring/services/prometheus-operated:web/proxy/api/v1/query?query=",
    );
  });

  it("uses the graphics-engine ratio for a MIG instance", async () => {
    const mig = {
      UUID: "GPU-a",
      GPU_I_ID: "3",
      GPU_I_PROFILE: "1g.5gb",
      pod: "infer-0",
      namespace: "ml",
    };
    const { fetch } = fakePrometheus({
      "avg_over_time(DCGM_FI_DEV_GPU_UTIL[1h])": [],
      "avg_over_time(DCGM_FI_PROF_GR_ENGINE_ACTIVE[1h])": [{ metric: mig, value: 0.2 }],
    });
    const result = await fetchGpuUtilization(fetch, { setting: undefined, services, pods: [] });
    expect(result.pods.get("ml/infer-0")?.utilization).toBeCloseTo(0.2);
  });

  it("falls back to scraping the exporter pods when no Prometheus has GPU series", async () => {
    const { fetch } = fakePrometheus({});
    const exporter: K8sPod = {
      metadata: {
        name: "nvidia-dcgm-exporter-abc",
        namespace: "gpu-operator",
        uid: "u",
        creationTimestamp: "",
        labels: { app: "nvidia-dcgm-exporter" },
      },
      spec: {
        containers: [{ name: "e", image: "i", ports: [{ containerPort: 9400, name: "metrics" }] }],
      },
      status: { phase: "Running" },
    };
    const scraped: string[] = [];
    const result = await fetchGpuUtilization(fetch, {
      setting: undefined,
      services,
      pods: [exporter],
      fetchText: async (path) => {
        scraped.push(path);
        return 'DCGM_FI_DEV_GPU_UTIL{UUID="GPU-b",pod="train-1",namespace="ml"} 12\n';
      },
    });
    expect(scraped).toEqual([
      "/api/v1/namespaces/gpu-operator/pods/nvidia-dcgm-exporter-abc:9400/proxy/metrics",
    ]);
    expect(result.source).toMatchObject({ kind: "exporter", scraped: 1 });
    expect(result.pods.get("ml/train-1")?.utilization).toBeCloseTo(0.12);
    expect(result.pods.get("ml/train-1")?.p95Utilization).toBeNull();
  });

  it("does nothing when turned off, and says so when nothing is found", async () => {
    const { fetch, seen } = fakePrometheus({});
    const off = await fetchGpuUtilization(fetch, { setting: "none", services, pods: [] });
    expect(off.source).toEqual({ kind: "none", reason: "disabled" });
    expect(seen).toEqual([]);

    const none = await fetchGpuUtilization(fetch, { setting: undefined, services: [], pods: [] });
    expect(none.source).toEqual({ kind: "none", reason: "not-found" });
  });

  it("reports an unreachable Prometheus distinctly", async () => {
    const failing = async <T>(): Promise<T> => {
      throw new Error("K8s API error 503 at x: service unavailable");
    };
    const result = await fetchGpuUtilization(failing, { setting: undefined, services, pods: [] });
    expect(result.source).toEqual({ kind: "none", reason: "unreachable" });
  });
});
