import { describe, it, expect } from "vitest";

import { allocateClusterCost, type CostModelNode, type CostModelPod } from "../cost-model.js";
import { allocationToCostRows, SERVICE_GPU, SERVICE_GPU_IDLE } from "../cost-data.js";
import { buildEfficiencyReport, formatEfficiencyReportText } from "../efficiency-report.js";
import { readNodeGpus } from "../gpu.js";
import { computeClusterCost } from "../cluster-cost.js";
import { parseNodeRates } from "../node-rates.js";
import { buildCostIndex } from "../cost-surface.js";
import { renderClusterDetail } from "../detail-renderers.js";

const GIB = 1024 ** 3;

/** An 8 × A100 40GB node at $32/hour with an explicit $3/GPU-hour: a $24 GPU pool. */
function gpuNode(over: Partial<CostModelNode> = {}): CostModelNode {
  return {
    name: "gpu-1",
    capacity: { cpuCores: 96, memoryBytes: 1152 * GIB },
    allocatable: { cpuCores: 96, memoryBytes: 1152 * GIB },
    instanceType: "p4d.24xlarge",
    hourlyRate: 32,
    perGpuHourlyRate: 3,
    gpus: readNodeGpus(
      { "nvidia.com/gpu.product": "NVIDIA-A100-SXM4-40GB", "nvidia.com/gpu.count": "8" },
      { "nvidia.com/gpu": "8" },
      undefined,
    ),
    ...over,
  };
}

function pod(over: Partial<CostModelPod> = {}): CostModelPod {
  return {
    name: "trainer-0",
    namespace: "ml",
    nodeName: "gpu-1",
    workload: "trainer",
    workloadKind: "StatefulSet",
    requests: { cpuCores: 0, memoryBytes: 0 },
    limits: { cpuCores: 0, memoryBytes: 0 },
    ...over,
  };
}

describe("GPU cost allocation", () => {
  it("charges GPU requests from the GPU pool and leaves the rest as idle GPUs", () => {
    const result = allocateClusterCost({
      nodes: [gpuNode()],
      pods: [pod({ acceleratorRequests: { "nvidia.com/gpu": 2 } })],
    });
    const p = result.pods[0]!;
    expect(p.gpus).toBe(2);
    expect(p.gpuHourlyCost).toBeCloseTo(6, 10); // 2/8 of $24
    expect(result.gpu.physical).toBe(8);
    expect(result.gpu.idle).toBe(6);
    expect(result.gpu.hourlyIdleCost).toBeCloseTo(18, 10);
    expect(result.gpu.hourlyCost).toBeCloseTo(24, 10);
  });

  it("charges a CPU-only pod on a GPU node for CPU and memory only", () => {
    const result = allocateClusterCost({
      nodes: [gpuNode()],
      pods: [pod({ requests: { cpuCores: 48, memoryBytes: 576 * GIB } })],
    });
    // Half the node's CPU and memory, of the $8 CPU/memory remainder.
    expect(result.pods[0]!.hourlyCost).toBeCloseTo(4, 10);
    expect(result.pods[0]!.gpuHourlyCost).toBeNull();
    expect(result.gpu.idle).toBe(8);
  });

  it("conserves the node's price across workloads and every bucket", () => {
    const result = allocateClusterCost({
      nodes: [gpuNode({ allocatable: { cpuCores: 94, memoryBytes: 1100 * GIB } })],
      pods: [
        pod({
          requests: { cpuCores: 8, memoryBytes: 64 * GIB },
          acceleratorRequests: { "nvidia.com/gpu": 3 },
        }),
        pod({ name: "web-0", workload: "web", requests: { cpuCores: 4, memoryBytes: 8 * GIB } }),
      ],
    });
    const total =
      (result.hourlyAllocatedCost ?? 0) +
      (result.hourlyIdleCost ?? 0) +
      (result.hourlySystemReservedCost ?? 0) +
      (result.gpu.hourlyIdleCost ?? 0);
    expect(total).toBeCloseTo(32, 8);
    const workloadSum = result.workloads.reduce((acc, w) => acc + (w.hourlyCost ?? 0), 0);
    expect(workloadSum).toBeCloseTo(result.hourlyAllocatedCost ?? 0, 8);
  });

  it("prices MIG slices as their fraction of the card", () => {
    const node = gpuNode({
      hourlyRate: 7,
      perGpuHourlyRate: 3.5,
      capacity: { cpuCores: 12, memoryBytes: 85 * GIB },
      allocatable: { cpuCores: 12, memoryBytes: 85 * GIB },
      gpus: readNodeGpus(
        { "nvidia.com/gpu.product": "NVIDIA-A100-SXM4-40GB", "nvidia.com/gpu.count": "1" },
        { "nvidia.com/mig-1g.5gb": "7" },
        undefined,
      ),
    });
    const result = allocateClusterCost({
      nodes: [node],
      pods: [pod({ acceleratorRequests: { "nvidia.com/mig-1g.5gb": 2 } })],
    });
    expect(result.pods[0]!.gpus).toBeCloseTo(2 / 7);
    expect(result.pods[0]!.gpuHourlyCost).toBeCloseTo(1, 10); // 2/7 of $3.50
    expect(result.gpu.idle).toBeCloseTo(5 / 7);
  });

  it("splits a time-sliced GPU by replicas and refuses to attribute its utilization", () => {
    const node = gpuNode({
      hourlyRate: 1,
      perGpuHourlyRate: 0.4,
      gpus: readNodeGpus(
        { "nvidia.com/gpu.replicas": "4", "nvidia.com/gpu.count": "1" },
        { "nvidia.com/gpu": "4" },
        undefined,
      ),
    });
    const result = allocateClusterCost({
      nodes: [node],
      pods: [
        pod({
          acceleratorRequests: { "nvidia.com/gpu": 1 },
          gpuUsage: {
            utilization: 0.9,
            memoryUsedMiB: 1,
            p95Utilization: null,
            peakMemoryMiB: null,
            devices: 1,
          },
        }),
      ],
    });
    expect(result.pods[0]!.gpuHourlyCost).toBeCloseTo(0.1, 10);
    expect(result.pods[0]!.gpuUtilization).toBeNull();
    expect(result.workloads[0]!.gpuUsageUnknown).toBe(true);
  });

  it("clamps GPU overcommit to the physical count", () => {
    const result = allocateClusterCost({
      nodes: [gpuNode()],
      pods: [
        pod({ acceleratorRequests: { "nvidia.com/gpu": 8 } }),
        pod({ name: "b", workload: "b", acceleratorRequests: { "nvidia.com/gpu": 8 } }),
      ],
    });
    expect(result.gpu.allocated).toBeCloseTo(8);
    expect(result.gpu.hourlyAllocatedCost).toBeCloseTo(24, 10);
    expect(result.gpu.idle).toBe(0);
  });

  it("reports requested-but-idle GPU cost from measured utilization", () => {
    const result = allocateClusterCost({
      nodes: [gpuNode()],
      pods: [
        pod({
          acceleratorRequests: { "nvidia.com/gpu": 1 },
          gpuUsage: {
            utilization: 0.25,
            memoryUsedMiB: 2048,
            p95Utilization: null,
            peakMemoryMiB: null,
            devices: 1,
          },
        }),
      ],
    });
    expect(result.pods[0]!.gpuWastedHourlyCost).toBeCloseTo(2.25, 10); // 75% of $3
    expect(result.workloads[0]!.gpuUtilization).toBeCloseTo(0.25);
    expect(result.gpu.wastedHourlyCost).toBeCloseTo(2.25, 10);
  });

  it("does not split anything on an unpriced GPU node, but still counts the GPUs", () => {
    const result = allocateClusterCost({
      nodes: [gpuNode({ hourlyRate: undefined })],
      pods: [pod({ acceleratorRequests: { "nvidia.com/gpu": 1 } })],
    });
    expect(result.pods[0]!.gpus).toBe(1);
    expect(result.pods[0]!.gpuHourlyCost).toBeNull();
    expect(result.gpu.hourlyCost).toBeNull();
    expect(result.gpu.unpricedNodes).toEqual(["gpu-1"]);
  });
});

describe("GPU right-sizing", () => {
  const usage = (p95: number, peakMiB: number) => ({
    utilization: p95 / 2,
    memoryUsedMiB: peakMiB / 2,
    p95Utilization: p95,
    peakMemoryMiB: peakMiB,
    devices: 1,
  });

  it("suggests a MIG profile for a whole GPU with a low p95 and a day of history", () => {
    const result = allocateClusterCost({
      nodes: [gpuNode()],
      pods: [
        pod({
          acceleratorRequests: { "nvidia.com/gpu": 1 },
          gpuUsage: usage(0.1, 4096),
          ageHours: 72,
        }),
      ],
    });
    const [finding] = result.gpu.rightsizing;
    expect(finding?.suggestion).toBe("mig");
    expect(finding?.profile?.name).toBe("1g.5gb");
    // $3/hour × 24 = $72/day today; a 1/7 slice is $72/7.
    expect(finding?.currentDailyCost).toBeCloseTo(72, 8);
    expect(finding?.savingDailyCost).toBeCloseTo(72 - 72 / 7, 8);
  });

  it("withholds a suggestion without history, or when one replica is busy", () => {
    const young = allocateClusterCost({
      nodes: [gpuNode()],
      pods: [
        pod({
          acceleratorRequests: { "nvidia.com/gpu": 1 },
          gpuUsage: usage(0.1, 4096),
          ageHours: 2,
        }),
      ],
    });
    expect(young.gpu.rightsizing).toEqual([]);

    const busyReplica = allocateClusterCost({
      nodes: [gpuNode()],
      pods: [
        pod({
          acceleratorRequests: { "nvidia.com/gpu": 1 },
          gpuUsage: usage(0.1, 4096),
          ageHours: 72,
        }),
        pod({
          name: "trainer-1",
          acceleratorRequests: { "nvidia.com/gpu": 1 },
          gpuUsage: usage(0.9, 30_000),
          ageHours: 72,
        }),
      ],
    });
    expect(busyReplica.gpu.rightsizing).toEqual([]);

    const instantOnly = allocateClusterCost({
      nodes: [gpuNode()],
      pods: [
        pod({
          acceleratorRequests: { "nvidia.com/gpu": 1 },
          gpuUsage: { ...usage(0.1, 4096), p95Utilization: null },
          ageHours: 72,
        }),
      ],
    });
    expect(instantOnly.gpu.rightsizing).toEqual([]);
  });

  it("suggests sharing for a low-p95 GPU with no MIG", () => {
    const t4 = gpuNode({
      gpus: readNodeGpus(
        { "nvidia.com/gpu.product": "Tesla-T4", "nvidia.com/gpu.count": "1" },
        { "nvidia.com/gpu": "1" },
        undefined,
      ),
    });
    const result = allocateClusterCost({
      nodes: [t4],
      pods: [
        pod({
          acceleratorRequests: { "nvidia.com/gpu": 1 },
          gpuUsage: usage(0.1, 1024),
          ageHours: 48,
        }),
      ],
    });
    expect(result.gpu.rightsizing[0]?.suggestion).toBe("share");
    expect(result.gpu.rightsizing[0]?.savingDailyCost).toBeNull();
  });
});

describe("GPU cost rows and report", () => {
  const allocation = allocateClusterCost({
    nodes: [gpuNode()],
    pods: [
      pod({
        acceleratorRequests: { "nvidia.com/gpu": 2 },
        requests: { cpuCores: 8, memoryBytes: 64 * GIB },
      }),
    ],
  });

  it("writes the GPU share and the idle GPUs under their own services", () => {
    const rows = allocationToCostRows(allocation, { fromDate: "2026-10-04", toDate: "2026-10-04" });
    const gpu = rows.find((r) => r.service === SERVICE_GPU)!;
    expect(gpu.amount).toBeCloseTo(6 * 24, 8);
    expect(gpu.tags?.["gpu_model"]).toBe("a100-40gb");
    const idle = rows.find((r) => r.service === SERVICE_GPU_IDLE)!;
    expect(idle.resourceId).toBe("node/gpu-1/gpu-idle");
    expect(idle.amount).toBeCloseTo(18 * 24, 8);
    // The partition holds: every row sums to the node's daily price.
    const sum = rows.reduce((acc, r) => acc + r.amount, 0);
    expect(sum).toBeCloseTo(32 * 24, 6);
  });

  it("puts GPU columns and totals in the efficiency report and its shared text", () => {
    const report = buildEfficiencyReport(allocation, "2026-10-04T00:00:00Z");
    expect(report.hasGpus).toBe(true);
    expect(report.totals.gpus).toBe(2);
    expect(report.totals.dailyIdleGpuCost).toBeCloseTo(18 * 24, 8);
    const text = formatEfficiencyReportText(report, "Report");
    expect(text).toContain("GPU BUSY");
    expect(text).toContain("Unrequested GPUs");
  });

  it("keeps a non-GPU report free of GPU columns", () => {
    const cpu = allocateClusterCost({
      nodes: [{ ...gpuNode(), gpus: null, perGpuHourlyRate: undefined }],
      pods: [pod({ requests: { cpuCores: 1, memoryBytes: GIB } })],
    });
    const report = buildEfficiencyReport(cpu, "2026-10-04T00:00:00Z");
    expect(report.hasGpus).toBe(false);
    expect(formatEfficiencyReportText(report, "Report")).not.toContain("GPU");
  });
});

describe("GPU end to end", () => {
  const node = {
    metadata: {
      name: "gpu-a",
      uid: "n",
      creationTimestamp: "",
      labels: {
        "node.kubernetes.io/instance-type": "a2-highgpu-1g",
        "cloud.google.com/gke-nodepool": "gpu-pool",
        "cloud.google.com/gke-accelerator": "nvidia-tesla-a100",
      },
    },
    status: {
      capacity: { cpu: "12", memory: "85Gi", "nvidia.com/gpu": "1" },
      allocatable: { cpu: "11", memory: "80Gi", "nvidia.com/gpu": "1" },
    },
  };
  const gpuPod = {
    metadata: {
      name: "infer-0",
      namespace: "ml",
      uid: "p",
      creationTimestamp: "",
      ownerReferences: [{ kind: "StatefulSet", name: "infer", controller: true }],
    },
    spec: {
      nodeName: "gpu-a",
      containers: [
        {
          name: "c",
          image: "i",
          resources: { limits: { "nvidia.com/gpu": "1" }, requests: { cpu: "4" } },
        },
      ],
    },
    status: { phase: "Running", startTime: "2026-10-01T00:00:00Z" },
  };
  const api = (path: string): unknown => {
    if (path === "/api/v1/nodes") return { items: [node] };
    if (path === "/api/v1/pods") return { items: [gpuPod] };
    if (path === "/api/v1/services") return { items: [] };
    if (path === "/api/v1/persistentvolumeclaims") return { items: [] };
    throw new Error("K8s API error 404 at x: NotFound");
  };
  const k8sFetch = async <T>(path: string): Promise<T> => api(path) as T;

  it("prices a GKE GPU pool by node label and per-GPU price, and renders the GPU tab", async () => {
    const rates = parseNodeRates(
      JSON.stringify({
        source: "list-price",
        byNodeLabel: { "cloud.google.com/gke-nodepool": { "gpu-pool": 4 } },
        gpuHourly: { "nvidia-tesla-a100": 2.93 },
      }),
    );
    const result = await computeClusterCost(k8sFetch, rates, {
      now: () => Date.parse("2026-10-04T00:00:00Z"),
    });
    const p = result.allocation.pods[0]!;
    expect(p.gpus).toBe(1);
    expect(p.gpuHourlyCost).toBeCloseTo(2.93, 10);
    expect(p.ageHours).toBeCloseTo(72, 6);
    expect(result.allocation.nodes[0]!.gpu?.priceBasis).toBe("per-gpu-price");
    expect(result.gpuMetrics).toEqual({ kind: "none", reason: "not-found" });

    const index = buildCostIndex(
      result.allocation,
      result.rateSource,
      result.utilization.status,
      "2026-10-04T00:00:00Z",
      result.gpuMetrics,
    );
    const view = renderClusterDetail(
      {
        id: "acc:k8s-cluster:c",
        pluginId: "kubernetes",
        resourceTypeId: "k8s-cluster",
        accountId: "acc",
        displayName: "c",
        fields: {},
        resolvedOutputs: {},
        secretStates: [],
        externalId: "c",
        createdAt: "",
        updatedAt: "",
      },
      index,
    );
    expect(view.customTabs?.some((t) => t.id === "gpus")).toBe(true);
    expect(JSON.stringify(view.sections)).toContain("(idle GPUs");
  });
});
