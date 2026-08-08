import { describe, it, expect } from "vitest";

import {
  DEFAULT_CPU_COST_SHARE,
  HOURS_PER_DAY,
  allocateClusterCost,
  formatDailyCost,
  formatEfficiency,
  formatMoney,
  isOverRequested,
  workloadKey,
  type CostModelNode,
  type CostModelPod,
} from "../cost-model.js";

const GIB = 1024 ** 3;

/** A 4-core / 16 GiB node at $1/hour, with a realistic allocatable haircut. */
function node(over: Partial<CostModelNode> = {}): CostModelNode {
  return {
    name: "node-1",
    capacity: { cpuCores: 4, memoryBytes: 16 * GIB },
    allocatable: { cpuCores: 3.9, memoryBytes: 15 * GIB },
    instanceType: "m5.xlarge",
    hourlyRate: 1,
    ...over,
  };
}

function pod(over: Partial<CostModelPod> = {}): CostModelPod {
  return {
    name: "p1",
    namespace: "app",
    nodeName: "node-1",
    workload: "web",
    workloadKind: "Deployment",
    requests: { cpuCores: 1, memoryBytes: 4 * GIB },
    limits: { cpuCores: 2, memoryBytes: 8 * GIB },
    ...over,
  };
}

describe("allocateClusterCost", () => {
  it("splits node cost between CPU and memory by the documented ratio", () => {
    const result = allocateClusterCost({
      nodes: [node()],
      // Exactly a quarter of both dimensions.
      pods: [pod()],
    });

    // 25% of the CPU pool + 25% of the memory pool = 25% of the node.
    expect(result.pods[0]!.hourlyCost).toBeCloseTo(0.25, 10);
    expect(result.cpuCostShare).toBe(DEFAULT_CPU_COST_SHARE);
  });

  it("weights an unbalanced pod by the CPU/memory split, not by an average", () => {
    // All the CPU, none of the memory: the pod should pay the whole CPU pool.
    const result = allocateClusterCost({
      nodes: [node()],
      pods: [pod({ requests: { cpuCores: 4, memoryBytes: 0 } })],
    });
    expect(result.pods[0]!.hourlyCost).toBeCloseTo(DEFAULT_CPU_COST_SHARE, 10);
  });

  it("honours a caller-supplied split", () => {
    const result = allocateClusterCost({
      nodes: [node()],
      pods: [pod({ requests: { cpuCores: 4, memoryBytes: 0 } })],
      cpuCostShare: 0.5,
    });
    expect(result.pods[0]!.hourlyCost).toBeCloseTo(0.5, 10);
  });

  it("charges the GREATER of request and usage", () => {
    // Under-requesting does not make a pod free — it is still on the machine.
    const result = allocateClusterCost({
      nodes: [node()],
      pods: [
        pod({
          requests: { cpuCores: 0.1, memoryBytes: 0 },
          usage: { cpuCores: 2, memoryBytes: 8 * GIB },
        }),
      ],
    });
    expect(result.pods[0]!.charged).toEqual({ cpuCores: 2, memoryBytes: 8 * GIB });
    expect(result.pods[0]!.hourlyCost).toBeCloseTo(0.5, 10);
  });

  it("charges the request when the pod idles below it", () => {
    // Reserved capacity is denied to everyone else, so it is still charged.
    const result = allocateClusterCost({
      nodes: [node()],
      pods: [
        pod({
          requests: { cpuCores: 2, memoryBytes: 8 * GIB },
          usage: { cpuCores: 0.05, memoryBytes: GIB / 10 },
        }),
      ],
    });
    expect(result.pods[0]!.charged).toEqual({ cpuCores: 2, memoryBytes: 8 * GIB });
    expect(result.pods[0]!.hourlyCost).toBeCloseTo(0.5, 10);
  });

  it("takes the greater PER DIMENSION, not per pod", () => {
    const result = allocateClusterCost({
      nodes: [node()],
      pods: [
        pod({
          requests: { cpuCores: 2, memoryBytes: GIB },
          usage: { cpuCores: 0.5, memoryBytes: 8 * GIB },
        }),
      ],
    });
    expect(result.pods[0]!.charged).toEqual({ cpuCores: 2, memoryBytes: 8 * GIB });
  });

  it("marks the basis as requests-only when there is no utilization", () => {
    const result = allocateClusterCost({ nodes: [node()], pods: [pod()] });
    expect(result.basis).toBe("requests");
    expect(result.pods[0]!.efficiency).toEqual({ cpu: null, memory: null });
    expect(result.efficiency).toEqual({ cpu: null, memory: null });
  });

  it("marks the basis as usage-or-requests when utilization exists", () => {
    const result = allocateClusterCost({
      nodes: [node()],
      pods: [pod({ usage: { cpuCores: 0.5, memoryBytes: GIB } })],
    });
    expect(result.basis).toBe("usage-or-requests");
  });

  it("reports efficiency as used over requested", () => {
    const result = allocateClusterCost({
      nodes: [node()],
      pods: [
        pod({
          requests: { cpuCores: 1, memoryBytes: 4 * GIB },
          usage: { cpuCores: 0.2, memoryBytes: GIB },
        }),
      ],
    });
    expect(result.pods[0]!.efficiency.cpu).toBeCloseTo(0.2, 10);
    expect(result.pods[0]!.efficiency.memory).toBeCloseTo(0.25, 10);
  });

  it("reports null efficiency rather than dividing by zero", () => {
    const result = allocateClusterCost({
      nodes: [node()],
      pods: [
        pod({
          requests: { cpuCores: 0, memoryBytes: 0 },
          usage: { cpuCores: 0.5, memoryBytes: GIB },
        }),
      ],
    });
    expect(result.pods[0]!.efficiency).toEqual({ cpu: null, memory: null });
  });

  describe("the zero-request pod", () => {
    it("costs nothing when it also uses nothing", () => {
      const result = allocateClusterCost({
        nodes: [node()],
        pods: [pod({ requests: { cpuCores: 0, memoryBytes: 0 } })],
      });
      expect(result.pods[0]!.hourlyCost).toBe(0);
      expect(result.pods[0]!.charged).toEqual({ cpuCores: 0, memoryBytes: 0 });
    });

    it("still costs money once it is observed using the machine", () => {
      // This is the case a requests-only model gets badly wrong: a
      // best-effort pod eating a whole node and being billed nothing.
      const result = allocateClusterCost({
        nodes: [node()],
        pods: [
          pod({
            requests: { cpuCores: 0, memoryBytes: 0 },
            usage: { cpuCores: 4, memoryBytes: 16 * GIB },
          }),
        ],
      });
      expect(result.pods[0]!.hourlyCost).toBeCloseTo(1, 10);
      expect(result.hourlyIdleCost).toBeCloseTo(0, 10);
    });
  });

  describe("the node with no pods", () => {
    it("is entirely idle plus system-reserved, and nobody is charged", () => {
      const result = allocateClusterCost({ nodes: [node()], pods: [] });
      const n = result.nodes[0]!;
      expect(n.podCount).toBe(0);
      expect(n.allocated).toEqual({ cpuCores: 0, memoryBytes: 0 });
      expect(n.idle).toEqual(n.allocatable);
      expect(result.hourlyAllocatedCost).toBe(0);
      // Idle + system-reserved account for the whole node price.
      expect(result.hourlyIdleCost! + result.hourlySystemReservedCost!).toBeCloseTo(1, 10);
      expect(result.hourlyTotalCost).toBe(1);
    });
  });

  describe("the pod on a node that no longer exists", () => {
    it("is reported with its requests but charged nothing", () => {
      const result = allocateClusterCost({
        nodes: [node()],
        pods: [pod({ name: "orphan", nodeName: "node-that-was-drained" })],
      });
      const orphan = result.pods.find((p) => p.name === "orphan")!;
      expect(orphan.unplaced).toBe(true);
      expect(orphan.hourlyCost).toBeNull();
      expect(orphan.dailyCost).toBeNull();
      expect(orphan.requests.cpuCores).toBe(1);
      // The surviving node is untouched — no phantom allocation against it.
      expect(result.nodes[0]!.podCount).toBe(0);
    });

    it("treats an unscheduled (Pending) pod the same way", () => {
      const result = allocateClusterCost({
        nodes: [node()],
        pods: [pod({ name: "pending", nodeName: "" })],
      });
      expect(result.pods[0]!.unplaced).toBe(true);
      expect(result.pods[0]!.hourlyCost).toBeNull();
    });

    it("still rolls unplaced pods into their namespace and workload", () => {
      const result = allocateClusterCost({
        nodes: [],
        pods: [pod({ nodeName: "" })],
      });
      expect(result.namespaces[0]!.namespace).toBe("app");
      expect(result.namespaces[0]!.podCount).toBe(1);
      expect(result.namespaces[0]!.dailyCost).toBeNull();
    });
  });

  describe("idle and system-reserved buckets", () => {
    it("keeps unallocated capacity out of the tenants' numbers", () => {
      // One pod on a quarter of the node; the other three quarters must NOT
      // be spread onto it.
      const result = allocateClusterCost({ nodes: [node()], pods: [pod()] });
      expect(result.pods[0]!.hourlyCost).toBeCloseTo(0.25, 10);
      expect(result.hourlyIdleCost).toBeGreaterThan(0);
      const total =
        result.hourlyAllocatedCost! + result.hourlyIdleCost! + result.hourlySystemReservedCost!;
      expect(total).toBeCloseTo(1, 10);
    });

    it("separates the kubelet's reservation from genuinely idle capacity", () => {
      const result = allocateClusterCost({ nodes: [node()], pods: [] });
      const n = result.nodes[0]!;
      expect(n.systemReserved.cpuCores).toBeCloseTo(0.1, 10);
      expect(n.systemReserved.memoryBytes).toBeCloseTo(GIB, 0);
      expect(n.idle.cpuCores).toBeCloseTo(3.9, 10);
    });

    it("shrinks system-reserved rather than going negative when pods overrun it", () => {
      const result = allocateClusterCost({
        nodes: [node()],
        pods: [pod({ usage: { cpuCores: 4, memoryBytes: 16 * GIB } })],
      });
      const n = result.nodes[0]!;
      expect(n.idle.cpuCores).toBe(0);
      expect(n.systemReserved.cpuCores).toBeGreaterThanOrEqual(0);
      expect(n.systemReserved.memoryBytes).toBeGreaterThanOrEqual(0);
    });
  });

  it("never distributes more than a node's own price", () => {
    // Three pods each claiming half the node — 150% overcommit.
    const result = allocateClusterCost({
      nodes: [node()],
      pods: [
        pod({ name: "a", requests: { cpuCores: 2, memoryBytes: 8 * GIB } }),
        pod({ name: "b", requests: { cpuCores: 2, memoryBytes: 8 * GIB } }),
        pod({ name: "c", requests: { cpuCores: 2, memoryBytes: 8 * GIB } }),
      ],
    });
    const sum = result.pods.reduce((acc, p) => acc + (p.hourlyCost ?? 0), 0);
    expect(sum).toBeCloseTo(1, 10);
    // Scaled proportionally, so all three are equal.
    expect(result.pods[0]!.hourlyCost).toBeCloseTo(1 / 3, 10);
  });

  describe("nodes with no rate", () => {
    it("reports capacity without money rather than a fabricated price", () => {
      const result = allocateClusterCost({
        nodes: [node({ hourlyRate: undefined })],
        pods: [pod()],
      });
      expect(result.pods[0]!.hourlyCost).toBeNull();
      expect(result.pods[0]!.dailyCost).toBeNull();
      expect(result.hourlyTotalCost).toBeNull();
      expect(result.pricedNodeCount).toBe(0);
      expect(result.fullyPriced).toBe(false);
      expect(result.unpricedNodes).toEqual(["node-1"]);
      // Capacity is still known — that's the point.
      expect(result.pods[0]!.cpuShare).toBeCloseTo(0.25, 10);
    });

    it("prices the nodes it can and names the ones it cannot", () => {
      const result = allocateClusterCost({
        nodes: [node(), node({ name: "node-2", hourlyRate: undefined })],
        pods: [pod(), pod({ name: "p2", nodeName: "node-2" })],
      });
      expect(result.pricedNodeCount).toBe(1);
      expect(result.nodeCount).toBe(2);
      expect(result.unpricedNodes).toEqual(["node-2"]);
      expect(result.fullyPriced).toBe(false);
      expect(result.pods.find((p) => p.name === "p1")!.hourlyCost).toBeCloseTo(0.25, 10);
      expect(result.pods.find((p) => p.name === "p2")!.hourlyCost).toBeNull();
    });

    it("reports fullyPriced only when every node has a rate", () => {
      const result = allocateClusterCost({ nodes: [node()], pods: [] });
      expect(result.fullyPriced).toBe(true);
    });

    it("is not fullyPriced for an empty cluster", () => {
      const result = allocateClusterCost({ nodes: [], pods: [] });
      expect(result.fullyPriced).toBe(false);
      expect(result.hourlyTotalCost).toBeNull();
    });
  });

  describe("roll-ups", () => {
    it("groups pods into workloads and namespaces", () => {
      const result = allocateClusterCost({
        nodes: [node({ capacity: { cpuCores: 8, memoryBytes: 32 * GIB } })],
        pods: [
          pod({ name: "web-1", namespace: "app", workload: "web" }),
          pod({ name: "web-2", namespace: "app", workload: "web" }),
          pod({
            name: "db-0",
            namespace: "data",
            workload: "db",
            workloadKind: "StatefulSet",
          }),
        ],
      });

      const web = result.workloads.find((w) => w.key === workloadKey("app", "Deployment", "web"))!;
      expect(web.podCount).toBe(2);
      expect(web.requests.cpuCores).toBe(2);

      const app = result.namespaces.find((n) => n.namespace === "app")!;
      expect(app.podCount).toBe(2);
      const data = result.namespaces.find((n) => n.namespace === "data")!;
      expect(data.podCount).toBe(1);
    });

    it("sorts namespaces most expensive first", () => {
      const result = allocateClusterCost({
        nodes: [node({ capacity: { cpuCores: 8, memoryBytes: 32 * GIB } })],
        pods: [
          pod({ name: "small", namespace: "cheap", requests: { cpuCores: 0.1, memoryBytes: 0 } }),
          pod({ name: "big", namespace: "spendy", requests: { cpuCores: 4, memoryBytes: 0 } }),
        ],
      });
      expect(result.namespaces.map((n) => n.namespace)).toEqual(["spendy", "cheap"]);
    });

    it("sorts workloads most expensive first", () => {
      const result = allocateClusterCost({
        nodes: [node({ capacity: { cpuCores: 8, memoryBytes: 32 * GIB } })],
        pods: [
          pod({ name: "a", workload: "cheap", requests: { cpuCores: 0.1, memoryBytes: 0 } }),
          pod({ name: "b", workload: "spendy", requests: { cpuCores: 4, memoryBytes: 0 } }),
        ],
      });
      expect(result.workloads.map((w) => w.workload)).toEqual(["spendy", "cheap"]);
    });

    it("keeps a system namespace in the roll-up like any other", () => {
      // The listing skip-set must not reach the cost model.
      const result = allocateClusterCost({
        nodes: [node()],
        pods: [pod({ namespace: "kube-system", workload: "coredns" })],
      });
      expect(result.namespaces.map((n) => n.namespace)).toContain("kube-system");
      expect(result.namespaces[0]!.dailyCost).toBeGreaterThan(0);
    });

    it("derives daily cost as 24x hourly", () => {
      const result = allocateClusterCost({ nodes: [node()], pods: [pod()] });
      expect(result.pods[0]!.dailyCost).toBeCloseTo(
        result.pods[0]!.hourlyCost! * HOURS_PER_DAY,
        10,
      );
      expect(result.dailyTotalCost).toBeCloseTo(24, 10);
    });

    it("produces workload keys that are stable across runs", () => {
      const input = {
        nodes: [node()],
        pods: [pod({ name: "web-1" }), pod({ name: "web-2" })],
      };
      const first = allocateClusterCost(input).workloads.map((w) => w.key);
      const second = allocateClusterCost(input).workloads.map((w) => w.key);
      expect(first).toEqual(second);
      expect(first).toEqual(["app/Deployment/web"]);
    });
  });

  it("survives a zero-capacity node without producing NaN", () => {
    const result = allocateClusterCost({
      nodes: [
        node({
          capacity: { cpuCores: 0, memoryBytes: 0 },
          allocatable: { cpuCores: 0, memoryBytes: 0 },
        }),
      ],
      pods: [pod()],
    });
    expect(result.pods[0]!.cpuShare).toBe(0);
    expect(result.pods[0]!.hourlyCost).toBe(0);
    expect(Number.isNaN(result.hourlyIdleCost!)).toBe(false);
  });

  it("clamps a nonsense CPU share instead of producing negative money", () => {
    const over = allocateClusterCost({ nodes: [node()], pods: [pod()], cpuCostShare: 5 });
    expect(over.cpuCostShare).toBe(1);
    const under = allocateClusterCost({ nodes: [node()], pods: [pod()], cpuCostShare: -1 });
    expect(under.cpuCostShare).toBe(0);
    const nan = allocateClusterCost({ nodes: [node()], pods: [pod()], cpuCostShare: NaN });
    expect(nan.cpuCostShare).toBe(DEFAULT_CPU_COST_SHARE);
  });

  it("carries the currency through", () => {
    const result = allocateClusterCost({ nodes: [node()], pods: [pod()], currency: "EUR" });
    expect(result.currency).toBe("EUR");
  });
});

describe("isOverRequested", () => {
  it("is false without utilization", () => {
    expect(isOverRequested({ cpu: null, memory: null })).toBe(false);
  });

  it("fires only when BOTH dimensions are badly under-used", () => {
    expect(isOverRequested({ cpu: 0.05, memory: 0.05 })).toBe(true);
    // Memory is well used, so the workload is not simply oversized.
    expect(isOverRequested({ cpu: 0.05, memory: 0.9 })).toBe(false);
  });

  it("respects a custom threshold", () => {
    expect(isOverRequested({ cpu: 0.3, memory: 0.3 })).toBe(false);
    expect(isOverRequested({ cpu: 0.3, memory: 0.3 }, 0.5)).toBe(true);
  });
});

describe("formatting", () => {
  it("scales precision to the magnitude", () => {
    expect(formatMoney(1234)).toBe("$1234");
    expect(formatMoney(1.5)).toBe("$1.50");
    expect(formatMoney(0.125)).toBe("$0.125");
    expect(formatMoney(0.0012)).toBe("$0.0012");
  });

  it("uses a symbol where it knows one and a code otherwise", () => {
    expect(formatMoney(1.5, "EUR")).toBe("€1.50");
    expect(formatMoney(1.5, "GBP")).toBe("1.50 GBP");
  });

  it("emits nothing at all when there is no cost", () => {
    expect(formatDailyCost(null)).toBe("");
    expect(formatDailyCost(1.8)).toBe("~$1.80/day");
  });

  it("renders efficiency as whole percentages", () => {
    expect(formatEfficiency({ cpu: 0.18, memory: 0.42 })).toBe("18% CPU · 42% mem");
    expect(formatEfficiency({ cpu: 0.18, memory: null })).toBe("18% CPU");
    expect(formatEfficiency({ cpu: null, memory: null })).toBe("");
  });
});
