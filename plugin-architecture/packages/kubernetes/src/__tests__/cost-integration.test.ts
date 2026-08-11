import { describe, it, expect } from "vitest";

import { computeClusterCost } from "../cluster-cost.js";
import { allocationToCostRows, SERVICE_IDLE, SERVICE_WORKLOAD } from "../cost-data.js";
import { buildCostIndex, costSubtitleSuffix, applyCostStatus } from "../cost-surface.js";
import { fetchClusterUtilization, describeUtilizationGap } from "../metrics-api.js";
import { parseNodeRates, rateForNode, hasAnyRate, EMPTY_RATE_TABLE } from "../node-rates.js";
import { buildCostMetricSeries } from "../metric-series.js";
import { namespacePeerGroup, podPeerGroup } from "../peer-groups.js";
import type { ResourceInstance } from "@infrawrench/plugin-base";

const GIB = 1024 ** 3;

/** A two-node cluster with a workload in `app` and one in `kube-system`. */
function fakeCluster(opts: { metrics?: "ok" | "404" | "503" } = {}) {
  const nodes = {
    items: [
      {
        metadata: {
          name: "node-a",
          uid: "u1",
          creationTimestamp: "2024-01-01T00:00:00Z",
          labels: {
            "node.kubernetes.io/instance-type": "s-2vcpu-4gb",
            "topology.kubernetes.io/zone": "nyc1a",
            "topology.kubernetes.io/region": "nyc1",
          },
        },
        status: {
          capacity: { cpu: "2", memory: "4Gi" },
          allocatable: { cpu: "1900m", memory: "3Gi" },
        },
      },
    ],
  };

  const pods = {
    items: [
      {
        metadata: {
          name: "web-abc-1",
          namespace: "app",
          uid: "p1",
          creationTimestamp: "2024-01-01T00:00:00Z",
          labels: { "pod-template-hash": "abc" },
          ownerReferences: [{ kind: "ReplicaSet", name: "web-abc", controller: true }],
        },
        spec: {
          nodeName: "node-a",
          containers: [
            { name: "c", image: "i", resources: { requests: { cpu: "500m", memory: "1Gi" } } },
          ],
        },
        status: { phase: "Running" },
      },
      {
        metadata: {
          name: "coredns-1",
          namespace: "kube-system",
          uid: "p2",
          creationTimestamp: "2024-01-01T00:00:00Z",
          ownerReferences: [{ kind: "DaemonSet", name: "coredns", controller: true }],
        },
        spec: {
          nodeName: "node-a",
          containers: [
            { name: "c", image: "i", resources: { requests: { cpu: "100m", memory: "128Mi" } } },
          ],
        },
        status: { phase: "Running" },
      },
      {
        // Terminal — must not be charged.
        metadata: {
          name: "backup-done",
          namespace: "app",
          uid: "p3",
          creationTimestamp: "2024-01-01T00:00:00Z",
        },
        spec: {
          nodeName: "node-a",
          containers: [{ name: "c", image: "i", resources: { requests: { cpu: "2" } } }],
        },
        status: { phase: "Succeeded" },
      },
    ],
  };

  const nodeMetrics = {
    items: [{ metadata: { name: "node-a" }, usage: { cpu: "300000000n", memory: "1Gi" } }],
  };
  const podMetrics = {
    items: [
      {
        metadata: { name: "web-abc-1", namespace: "app" },
        containers: [{ name: "c", usage: { cpu: "50000000n", memory: "256Mi" } }],
      },
    ],
  };

  return async function k8sFetch<T>(path: string): Promise<T> {
    if (path === "/api/v1/nodes") return nodes as T;
    if (path === "/api/v1/pods") return pods as T;
    if (path.startsWith("/apis/metrics.k8s.io/")) {
      if (opts.metrics === "404") {
        throw new Error(`K8s API error 404 at https://x${path}: {"reason":"NotFound"}`);
      }
      if (opts.metrics === "503") {
        throw new Error(`K8s API error 503 at https://x${path}: service unavailable`);
      }
      return (path.endsWith("/nodes") ? nodeMetrics : podMetrics) as T;
    }
    throw new Error(`unexpected path ${path}`);
  };
}

const RATES = parseNodeRates(
  JSON.stringify({
    currency: "USD",
    source: "billed",
    byInstanceType: { "s-2vcpu-4gb": 0.0357 },
  }),
);

describe("parseNodeRates", () => {
  it("parses the JSON payload a cloud plugin emits", () => {
    const table = parseNodeRates(
      JSON.stringify({
        currency: "EUR",
        source: "billed",
        byInstanceType: { "m5.large": 0.096 },
        byNodeName: { "node-1": 0.5 },
      }),
    );
    expect(table.currency).toBe("EUR");
    expect(table.source).toBe("billed");
    expect(rateForNode(table, "node-1", "m5.large")).toBe(0.5);
    expect(rateForNode(table, "node-2", "m5.large")).toBe(0.096);
    expect(rateForNode(table, "node-2", "unknown")).toBeUndefined();
  });

  it("parses the hand-typed form", () => {
    const table = parseNodeRates("s-2vcpu-4gb=0.0357, m5.large=0.096");
    expect(table.source).toBe("manual");
    expect(rateForNode(table, "n", "m5.large")).toBe(0.096);
  });

  it("returns an empty table rather than throwing on junk", () => {
    expect(parseNodeRates("{not json")).toEqual(EMPTY_RATE_TABLE);
    expect(parseNodeRates("")).toEqual(EMPTY_RATE_TABLE);
    expect(parseNodeRates(undefined)).toEqual(EMPTY_RATE_TABLE);
    expect(hasAnyRate(parseNodeRates(""))).toBe(false);
  });

  it("drops negative and non-numeric rates instead of trusting them", () => {
    const table = parseNodeRates(JSON.stringify({ byInstanceType: { a: -1, b: "nope", c: 0.5 } }));
    expect(table.byInstanceType).toEqual({ c: 0.5 });
  });

  it("treats an unknown source as a list price, never as billed", () => {
    expect(parseNodeRates(JSON.stringify({ source: "wishful" })).source).toBe("list-price");
  });
});

describe("fetchClusterUtilization", () => {
  it("reads node and pod usage when metrics-server is present", async () => {
    const util = await fetchClusterUtilization(fakeCluster());
    expect(util.status.available).toBe(true);
    expect(util.nodes.get("node-a")!.cpuCores).toBeCloseTo(0.3, 6);
    expect(util.pods.get("app/web-abc-1")!.memoryBytes).toBe(256 * 1024 ** 2);
  });

  it("degrades to no data on 404 rather than throwing", async () => {
    const util = await fetchClusterUtilization(fakeCluster({ metrics: "404" }));
    expect(util.status).toEqual({ available: false, reason: "not-installed" });
    expect(util.pods.size).toBe(0);
    expect(describeUtilizationGap(util.status)).toContain("metrics-server is not installed");
  });

  it("distinguishes a registered-but-unreachable API (503)", async () => {
    const util = await fetchClusterUtilization(fakeCluster({ metrics: "503" }));
    expect(util.status).toEqual({ available: false, reason: "unhealthy" });
    expect(describeUtilizationGap(util.status)).toContain("unreachable");
  });

  it("says nothing when utilization is fine", () => {
    expect(describeUtilizationGap({ available: true })).toBeNull();
  });
});

describe("computeClusterCost", () => {
  it("allocates node price across the pods on it", async () => {
    const result = await computeClusterCost(fakeCluster(), RATES);
    expect(result.unpriced).toBe(false);
    expect(result.rateSource).toBe("billed");
    expect(result.allocation.hourlyTotalCost).toBeCloseTo(0.0357, 10);
    const web = result.allocation.workloads.find((w) => w.workload === "web")!;
    expect(web.workloadKind).toBe("Deployment");
    expect(web.dailyCost).toBeGreaterThan(0);
  });

  it("includes system namespaces — kube-system's cost must not vanish", async () => {
    const result = await computeClusterCost(fakeCluster(), RATES);
    const names = result.allocation.namespaces.map((n) => n.namespace);
    expect(names).toContain("kube-system");
    const sys = result.allocation.namespaces.find((n) => n.namespace === "kube-system")!;
    expect(sys.dailyCost).toBeGreaterThan(0);
  });

  it("excludes terminal pods, which hold no capacity", async () => {
    const result = await computeClusterCost(fakeCluster(), RATES);
    expect(result.allocation.pods.map((p) => p.name)).not.toContain("backup-done");
  });

  it("reads capacity separately from allocatable", async () => {
    const result = await computeClusterCost(fakeCluster(), RATES);
    const node = result.allocation.nodes[0]!;
    expect(node.capacity).toEqual({ cpuCores: 2, memoryBytes: 4 * GIB });
    // `1900m` is 1900 * 1e-3 in binary floating point, so compare loosely.
    expect(node.allocatable.cpuCores).toBeCloseTo(1.9, 10);
    expect(node.allocatable.memoryBytes).toBe(3 * GIB);
    expect(node.systemReserved.cpuCores).toBeGreaterThan(0);
    expect(node.region).toBe("nyc1");
  });

  it("falls back to requests when metrics-server is absent", async () => {
    const result = await computeClusterCost(fakeCluster({ metrics: "404" }), RATES);
    expect(result.allocation.basis).toBe("requests");
    expect(result.utilization.status.available).toBe(false);
    // Still fully costed — only the efficiency figures are missing.
    expect(result.allocation.hourlyTotalCost).toBeCloseTo(0.0357, 10);
    expect(result.allocation.efficiency).toEqual({ cpu: null, memory: null });
  });

  it("shows capacity without money when there is no rate", async () => {
    const result = await computeClusterCost(fakeCluster(), EMPTY_RATE_TABLE);
    expect(result.unpriced).toBe(true);
    expect(result.allocation.hourlyTotalCost).toBeNull();
    // Capacity is still real.
    expect(result.allocation.nodes[0]!.capacity.cpuCores).toBe(2);
  });
});

describe("allocationToCostRows", () => {
  const range = { fromDate: "2026-08-07", toDate: "2026-08-08" };

  it("emits one row per workload plus explicit idle and reserved buckets", async () => {
    const { allocation } = await computeClusterCost(fakeCluster(), RATES);
    const rows = allocationToCostRows(allocation, range);

    expect(rows.every((r) => r.date === "2026-08-08")).toBe(true);
    expect(rows.every((r) => r.currency === "USD")).toBe(true);

    const workloadRows = rows.filter((r) => r.service === SERVICE_WORKLOAD);
    expect(workloadRows.map((r) => r.resourceId).sort()).toEqual([
      "app/Deployment/web",
      "kube-system/DaemonSet/coredns",
    ]);

    const idle = rows.find((r) => r.service === SERVICE_IDLE)!;
    expect(idle.amount).toBeGreaterThan(0);
  });

  it("carries namespace and workload as tags, since CostRow has no such dimension", async () => {
    const { allocation } = await computeClusterCost(fakeCluster(), RATES);
    const rows = allocationToCostRows(allocation, range);
    const web = rows.find((r) => r.resourceId === "app/Deployment/web")!;
    expect(web.tags).toEqual({
      namespace: "app",
      workload: "web",
      workload_kind: "Deployment",
      system: "false",
    });
    const dns = rows.find((r) => r.resourceId === "kube-system/DaemonSet/coredns")!;
    expect(dns.tags!["system"]).toBe("true");
  });

  it("reproduces identical dimension keys when a day is re-run", async () => {
    const a = allocationToCostRows(
      (await computeClusterCost(fakeCluster(), RATES)).allocation,
      range,
    );
    const b = allocationToCostRows(
      (await computeClusterCost(fakeCluster(), RATES)).allocation,
      range,
    );
    const key = (rows: typeof a) =>
      rows.map((r) => `${r.date}|${r.service}|${r.resourceId}|${JSON.stringify(r.tags)}`);
    expect(key(a)).toEqual(key(b));
    expect(a.map((r) => r.amount)).toEqual(b.map((r) => r.amount));
  });

  it("emits nothing at all when nothing could be priced", async () => {
    const { allocation } = await computeClusterCost(fakeCluster(), EMPTY_RATE_TABLE);
    // Zero rows, not zero-amount rows: "we don't know" is not "it's free".
    expect(allocationToCostRows(allocation, range)).toEqual([]);
  });

  it("sums to the cluster's total spend", async () => {
    const { allocation } = await computeClusterCost(fakeCluster(), RATES);
    const rows = allocationToCostRows(allocation, range);
    const total = rows.reduce((acc, r) => acc + r.amount, 0);
    expect(total).toBeCloseTo(allocation.dailyTotalCost!, 8);
  });
});

describe("peer-pane surfacing", () => {
  function ri(typeId: string, fields: Record<string, string | number | boolean>): ResourceInstance {
    return {
      id: `acct:${typeId}:${fields["namespace"] ?? ""}:${fields["name"]}`,
      pluginId: "kubernetes",
      resourceTypeId: typeId,
      accountId: "acct",
      displayName: String(fields["name"]),
      fields,
      resolvedOutputs: {},
      secretStates: [],
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    };
  }

  it("appends cost and efficiency to a pod pill subtitle", async () => {
    const result = await computeClusterCost(fakeCluster(), RATES);
    const index = buildCostIndex(
      result.allocation,
      result.rateSource,
      result.utilization.status,
      "2026-08-11T00:00:00.000Z",
    );

    const group = podPeerGroup(
      [ri("k8s-pod", { name: "web-abc-1", namespace: "app", image: "nginx", status: "Running" })],
      index,
    );
    expect(group.items[0]!.subtitle).toMatch(/^app · nginx · ~\$[\d.]+\/day · \d+% (CPU|mem)$/);
  });

  it("leaves subtitles untouched when there is no cost data", () => {
    const group = podPeerGroup([
      ri("k8s-pod", { name: "p", namespace: "app", image: "nginx", status: "Running" }),
    ]);
    expect(group.items[0]!.subtitle).toBe("app · nginx");
  });

  it("orders the namespace group by cost and says so in the title", async () => {
    const result = await computeClusterCost(fakeCluster(), RATES);
    const index = buildCostIndex(
      result.allocation,
      result.rateSource,
      result.utilization.status,
      "2026-08-11T00:00:00.000Z",
    );
    const group = namespacePeerGroup(
      [
        ri("k8s-namespace", { name: "kube-system", phase: "Active" }),
        ri("k8s-namespace", { name: "app", phase: "Active" }),
      ],
      index,
    );
    expect(group.title).toContain("by cost");
    // `app` requests 500m/1Gi against kube-system's 100m/128Mi.
    expect(group.items.map((i) => i.displayName)).toEqual(["app", "kube-system"]);
  });

  it("does not claim a cost ordering when there is no cost", () => {
    const group = namespacePeerGroup([ri("k8s-namespace", { name: "app", phase: "Active" })]);
    expect(group.title).toBe("Namespaces (1)");
  });

  it("keeps the subtitle to two cost fragments so a pill stays one line", () => {
    const suffix = costSubtitleSuffix(
      { dailyCost: 1.8, efficiency: { cpu: 0.18, memory: 0.42 } },
      "USD",
    );
    expect(suffix).toBe(" · ~$1.80/day · 18% CPU");
  });

  it("omits the money fragment entirely when there is no rate", () => {
    expect(
      costSubtitleSuffix({ dailyCost: null, efficiency: { cpu: 0.5, memory: null } }, "USD"),
    ).toBe(" · 50% CPU");
    expect(
      costSubtitleSuffix({ dailyCost: null, efficiency: { cpu: null, memory: null } }, "USD"),
    ).toBe("");
  });

  describe("status flagging", () => {
    const wasteful = { dailyCost: 5, efficiency: { cpu: 0.02, memory: 0.03 } };

    it("degrades a healthy but badly over-requested workload", () => {
      expect(applyCostStatus("healthy", wasteful, true)).toBe("degraded");
    });

    it("never fires without utilization — requests prove nothing about waste", () => {
      expect(applyCostStatus("healthy", wasteful, false)).toBe("healthy");
      expect(
        applyCostStatus("healthy", { dailyCost: 5, efficiency: { cpu: null, memory: null } }, true),
      ).toBe("healthy");
    });

    it("never upgrades a broken workload just because it is thrifty", () => {
      expect(applyCostStatus("error", wasteful, true)).toBe("error");
      expect(
        applyCostStatus("error", { dailyCost: 1, efficiency: { cpu: 0.9, memory: 0.9 } }, true),
      ).toBe("error");
    });
  });
});

describe("buildCostMetricSeries", () => {
  it("charts cluster cost with idle as its own line", async () => {
    const result = await computeClusterCost(fakeCluster(), RATES);
    const index = buildCostIndex(
      result.allocation,
      result.rateSource,
      result.utilization.status,
      "2026-08-11T00:00:00.000Z",
    );
    const series = buildCostMetricSeries("k8s-cluster", {}, "cluster", index, {
      startMs: 1000,
      endMs: 2000,
    });
    const labels = series.map((s) => s.label);
    expect(labels).toContain("Cluster cost");
    expect(labels).toContain("Idle capacity");
    expect(series[0]!.points).toEqual([
      { timestamp: 1000, value: expect.any(Number) },
      { timestamp: 2000, value: expect.any(Number) },
    ]);
    expect(series[0]!.unit).toBe("USD/day");
  });

  it("charts a namespace's own cost", async () => {
    const result = await computeClusterCost(fakeCluster(), RATES);
    const index = buildCostIndex(
      result.allocation,
      result.rateSource,
      result.utilization.status,
      "2026-08-11T00:00:00.000Z",
    );
    const series = buildCostMetricSeries("k8s-namespace", { name: "app" }, "app", index);
    expect(series.map((s) => s.label)).toContain("Namespace cost");
  });

  it("returns nothing for a kind with no cost dimension", async () => {
    const result = await computeClusterCost(fakeCluster(), RATES);
    const index = buildCostIndex(
      result.allocation,
      result.rateSource,
      result.utilization.status,
      "2026-08-11T00:00:00.000Z",
    );
    expect(buildCostMetricSeries("k8s-secret", {}, "s", index)).toEqual([]);
  });

  it("omits money series entirely when there is no rate", async () => {
    const result = await computeClusterCost(fakeCluster(), EMPTY_RATE_TABLE);
    const index = buildCostIndex(
      result.allocation,
      result.rateSource,
      result.utilization.status,
      "2026-08-11T00:00:00.000Z",
    );
    const series = buildCostMetricSeries("k8s-cluster", {}, "cluster", index);
    expect(series.map((s) => s.label)).not.toContain("Cluster cost");
    // Efficiency survives — it needs no price.
    expect(series.map((s) => s.label)).toContain("CPU efficiency");
  });
});
