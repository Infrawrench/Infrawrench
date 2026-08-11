/**
 * The non-compute half of the allocation: storage, load balancers, the control
 * plane, and the waste figures the efficiency report is built from.
 */

import { describe, it, expect } from "vitest";

import {
  HOURS_PER_DAY,
  HOURS_PER_MONTH,
  allocateClusterCost,
  type CostModelLoadBalancer,
  type CostModelNode,
  type CostModelPod,
  type CostModelVolume,
} from "../cost-model.js";
import {
  SERVICE_CONTROL_PLANE,
  SERVICE_LOAD_BALANCER,
  SERVICE_STORAGE,
  SERVICE_STORAGE_IDLE,
  SERVICE_WORKLOAD,
  allocationToCostRows,
} from "../cost-data.js";

const GIB = 1024 ** 3;
const RANGE = { fromDate: "2026-08-11", toDate: "2026-08-11" };

function node(over: Partial<CostModelNode> = {}): CostModelNode {
  return {
    name: "node-1",
    capacity: { cpuCores: 4, memoryBytes: 16 * GIB },
    allocatable: { cpuCores: 4, memoryBytes: 16 * GIB },
    instanceType: "m5.xlarge",
    hourlyRate: 1,
    ...over,
  };
}

function pod(over: Partial<CostModelPod> = {}): CostModelPod {
  return {
    name: "web-1",
    namespace: "app",
    nodeName: "node-1",
    workload: "web",
    workloadKind: "Deployment",
    requests: { cpuCores: 1, memoryBytes: 4 * GIB },
    limits: { cpuCores: 2, memoryBytes: 8 * GIB },
    ...over,
  };
}

function volume(over: Partial<CostModelVolume> = {}): CostModelVolume {
  return {
    name: "data",
    namespace: "app",
    phase: "Bound",
    storageClass: "gp3",
    gib: 100,
    capacityBasis: "provisioned",
    mountedBy: [{ workload: "web", workloadKind: "Deployment" }],
    gibMonthRate: 0.08,
    ...over,
  };
}

function loadBalancer(over: Partial<CostModelLoadBalancer> = {}): CostModelLoadBalancer {
  return {
    name: "web-lb",
    namespace: "app",
    address: "203.0.113.10",
    loadBalancerClass: "",
    target: { workload: "web", workloadKind: "Deployment" },
    hourlyRate: 0.025,
    ...over,
  };
}

describe("persistent volumes", () => {
  it("prices a claim per provisioned GiB-month over a 730-hour month", () => {
    const result = allocateClusterCost({ nodes: [node()], pods: [pod()], volumes: [volume()] });
    const expectedHourly = (100 * 0.08) / HOURS_PER_MONTH;
    expect(result.storage.hourlyAttributedCost).toBeCloseTo(expectedHourly, 12);
    expect(result.storage.dailyAttributedCost).toBeCloseTo(expectedHourly * HOURS_PER_DAY, 12);
  });

  it("charges the claim to the one workload that mounts it", () => {
    const result = allocateClusterCost({ nodes: [node()], pods: [pod()], volumes: [volume()] });
    const web = result.workloads.find((w) => w.workload === "web")!;
    expect(web.storageGib).toBe(100);
    expect(web.storageDailyCost).toBeCloseTo(((100 * 0.08) / HOURS_PER_MONTH) * HOURS_PER_DAY, 12);
    // The total is compute plus the disk, and the parts remain separable.
    expect(web.dailyCost).toBeCloseTo(web.computeDailyCost! + web.storageDailyCost!, 12);
  });

  it("charges a shared claim to the namespace and to no workload", () => {
    const result = allocateClusterCost({
      nodes: [node()],
      pods: [pod(), pod({ name: "worker-1", workload: "worker" })],
      volumes: [
        volume({
          mountedBy: [
            { workload: "web", workloadKind: "Deployment" },
            { workload: "worker", workloadKind: "Deployment" },
          ],
        }),
      ],
    });

    expect(result.storage.volumes[0]!.shared).toBe(true);
    for (const workload of result.workloads) expect(workload.storageGib).toBe(0);
    expect(result.namespaces.find((n) => n.namespace === "app")!.storageGib).toBe(100);
  });

  it("puts a bound-but-unmounted claim in its own bucket, not on the namespace", () => {
    const result = allocateClusterCost({
      nodes: [node()],
      pods: [pod()],
      volumes: [volume({ name: "left-behind", mountedBy: [] })],
    });

    expect(result.storage.unattachedCount).toBe(1);
    expect(result.storage.unattachedGib).toBe(100);
    expect(result.storage.hourlyUnattachedCost).toBeGreaterThan(0);
    // The tenant is not charged for it.
    expect(result.storage.hourlyAttributedCost).toBeNull();
    expect(result.namespaces.find((n) => n.namespace === "app")!.storageGib).toBe(0);
  });

  it("counts an unbound claim but never prices it", () => {
    const result = allocateClusterCost({
      nodes: [node()],
      pods: [pod()],
      volumes: [volume({ phase: "Pending", capacityBasis: "requested", mountedBy: [] })],
    });

    expect(result.storage.unboundCount).toBe(1);
    expect(result.storage.unboundGib).toBe(100);
    expect(result.storage.volumes[0]!.hourlyCost).toBeNull();
    expect(result.storage.hourlyUnattachedCost).toBeNull();
    // Unbound is not counted as bound capacity either.
    expect(result.storage.gib).toBe(0);
  });

  it("renders capacity with no money when the storage class has no price", () => {
    const result = allocateClusterCost({
      nodes: [node()],
      pods: [pod()],
      volumes: [volume({ gibMonthRate: undefined, storageClass: "fast-local" })],
    });

    expect(result.storage.gib).toBe(100);
    expect(result.storage.hourlyAttributedCost).toBeNull();
    expect(result.storage.unpricedClasses).toEqual(["fast-local"]);
    // The workload still shows the GiB it holds, just no storage money.
    const web = result.workloads.find((w) => w.workload === "web")!;
    expect(web.storageGib).toBe(100);
    expect(web.storageDailyCost).toBeNull();
  });
});

describe("load balancers", () => {
  it("charges a provisioned load balancer to the workload behind its selector", () => {
    const result = allocateClusterCost({
      nodes: [node()],
      pods: [pod()],
      loadBalancers: [loadBalancer()],
    });

    const web = result.workloads.find((w) => w.workload === "web")!;
    expect(web.loadBalancerCount).toBe(1);
    expect(web.loadBalancerDailyCost).toBeCloseTo(0.025 * HOURS_PER_DAY, 12);
    expect(result.loadBalancers.provisionedCount).toBe(1);
  });

  it("counts an unprovisioned load balancer without charging for it", () => {
    const result = allocateClusterCost({
      nodes: [node()],
      pods: [pod()],
      loadBalancers: [loadBalancer({ address: "" })],
    });

    expect(result.loadBalancers.count).toBe(1);
    expect(result.loadBalancers.provisionedCount).toBe(0);
    expect(result.loadBalancers.hourlyCost).toBeNull();
    expect(result.loadBalancers.loadBalancers[0]!.pending).toBe(true);
  });

  it("charges an ambiguous load balancer to the namespace only", () => {
    const result = allocateClusterCost({
      nodes: [node()],
      pods: [pod()],
      loadBalancers: [loadBalancer({ target: undefined })],
    });

    for (const workload of result.workloads) expect(workload.loadBalancerCount).toBe(0);
    expect(result.namespaces.find((n) => n.namespace === "app")!.loadBalancerCount).toBe(1);
  });

  it("honours a zero per-service rate, which is how MetalLB is excluded", () => {
    const result = allocateClusterCost({
      nodes: [node()],
      pods: [pod()],
      loadBalancers: [loadBalancer({ hourlyRate: 0, loadBalancerClass: "metallb.io/metallb" })],
    });

    // Zero is a known price, not a missing one — the difference is that this
    // must not be reported as "counted without cost".
    expect(result.loadBalancers.hourlyCost).toBe(0);
    expect(result.loadBalancers.anyUnpriced).toBe(false);
  });
});

describe("the control plane bucket", () => {
  it("is its own line and is never divided across tenants", () => {
    const result = allocateClusterCost({
      nodes: [node()],
      pods: [pod(), pod({ name: "api-1", namespace: "other", workload: "api" })],
      controlPlaneHourlyRate: 0.1,
    });

    expect(result.hourlyControlPlaneCost).toBe(0.1);
    expect(result.dailyControlPlaneCost).toBeCloseTo(2.4, 12);
    // Not a cent of it reached a namespace.
    const namespaceTotal = result.namespaces.reduce((acc, ns) => acc + (ns.dailyCost ?? 0), 0);
    expect(namespaceTotal).toBeCloseTo(result.dailyAllocatedCost!, 10);
  });

  it("is absent for a self-managed cluster rather than assumed", () => {
    const result = allocateClusterCost({ nodes: [node()], pods: [pod()] });
    expect(result.hourlyControlPlaneCost).toBeNull();
    // Node cost alone, because there is nothing else billed.
    expect(result.hourlyTotalCost).toBe(result.hourlyNodeCost);
  });

  it("adds every component into the cluster total", () => {
    const result = allocateClusterCost({
      nodes: [node()],
      pods: [pod()],
      volumes: [volume(), volume({ name: "orphan", mountedBy: [] })],
      loadBalancers: [loadBalancer()],
      controlPlaneHourlyRate: 0.1,
    });

    const expected = 1 + 0.1 + (200 * 0.08) / HOURS_PER_MONTH + 0.025;
    expect(result.hourlyTotalCost).toBeCloseTo(expected, 12);
    // Node cost stays the compute-only figure the idle percentage divides by.
    expect(result.hourlyNodeCost).toBe(1);
  });
});

describe("waste", () => {
  it("is null, not zero, when nothing measured the pod", () => {
    const result = allocateClusterCost({ nodes: [node()], pods: [pod()] });
    expect(result.pods[0]!.wasted).toBeNull();
    expect(result.pods[0]!.wastedHourlyCost).toBeNull();
    expect(result.workloads[0]!.usageUnknown).toBe(true);
    expect(result.wasted).toBeNull();
  });

  it("is the priced gap between what is charged and what is used", () => {
    // Requests 1 core / 4 GiB of a 4-core / 16 GiB node; uses a quarter of it.
    const result = allocateClusterCost({
      nodes: [node()],
      pods: [pod({ usage: { cpuCores: 0.25, memoryBytes: GIB } })],
    });

    const podAlloc = result.pods[0]!;
    expect(podAlloc.wasted).toEqual({ cpuCores: 0.75, memoryBytes: 3 * GIB });
    // Three quarters of a pod that holds a quarter of the node = 3/16 of it.
    expect(podAlloc.wastedHourlyCost).toBeCloseTo(0.1875, 10);
    expect(podAlloc.wastedHourlyCost).toBeLessThan(podAlloc.hourlyCost!);
    expect(result.workloads[0]!.usageUnknown).toBe(false);
  });

  it("is zero for a pod that uses everything it asked for", () => {
    const result = allocateClusterCost({
      nodes: [node()],
      pods: [pod({ usage: { cpuCores: 1, memoryBytes: 4 * GIB } })],
    });
    expect(result.pods[0]!.wastedHourlyCost).toBeCloseTo(0, 12);
  });

  it("never goes negative when usage exceeds the request", () => {
    const result = allocateClusterCost({
      nodes: [node()],
      pods: [pod({ usage: { cpuCores: 2, memoryBytes: 8 * GIB } })],
    });
    expect(result.pods[0]!.wasted).toEqual({ cpuCores: 0, memoryBytes: 0 });
    expect(result.pods[0]!.wastedHourlyCost).toBeCloseTo(0, 12);
  });
});

describe("cost rows", () => {
  it("keeps the service labels a partition of the bill", () => {
    const result = allocateClusterCost({
      nodes: [node()],
      pods: [pod()],
      volumes: [volume(), volume({ name: "orphan", mountedBy: [] })],
      loadBalancers: [loadBalancer()],
      controlPlaneHourlyRate: 0.1,
    });
    const rows = allocationToCostRows(result, RANGE);
    const services = new Set(rows.map((r) => r.service));

    expect(services).toContain(SERVICE_WORKLOAD);
    expect(services).toContain(SERVICE_STORAGE);
    expect(services).toContain(SERVICE_STORAGE_IDLE);
    expect(services).toContain(SERVICE_LOAD_BALANCER);
    expect(services).toContain(SERVICE_CONTROL_PLANE);

    // The workload row is compute only: adding its disk and its load balancer
    // there as well would count the same money under two service labels.
    const workloadRow = rows.find((r) => r.service === SERVICE_WORKLOAD)!;
    const web = result.workloads.find((w) => w.workload === "web")!;
    expect(workloadRow.amount).toBeCloseTo(web.computeDailyCost!, 12);

    // And the rows still add up to the cluster total.
    const rowTotal = rows.reduce((acc, r) => acc + r.amount, 0);
    expect(rowTotal).toBeCloseTo(result.dailyTotalCost!, 8);
  });

  it("tags an unattached claim with its namespace so it can be found and deleted", () => {
    const result = allocateClusterCost({
      nodes: [node()],
      pods: [pod()],
      volumes: [volume({ name: "orphan", mountedBy: [] })],
    });
    const row = allocationToCostRows(result, RANGE).find(
      (r) => r.service === SERVICE_STORAGE_IDLE,
    )!;

    expect(row.resourceId).toBe("app/PersistentVolumeClaim/orphan");
    expect(row.tags?.["namespace"]).toBe("app");
    expect(row.tags?.["workload"]).toBe("");
  });

  it("writes no rows at all when nothing could be priced", () => {
    const result = allocateClusterCost({
      nodes: [node({ hourlyRate: undefined })],
      pods: [pod()],
      volumes: [volume({ gibMonthRate: undefined })],
      loadBalancers: [loadBalancer({ hourlyRate: undefined })],
    });
    expect(allocationToCostRows(result, RANGE)).toEqual([]);
  });

  it("still writes the control-plane row when the nodes have no rate", () => {
    // A managed cluster whose node prices are unknown still has a known,
    // published, flat cluster fee. Suppressing it would lose real money.
    const result = allocateClusterCost({
      nodes: [node({ hourlyRate: undefined })],
      pods: [pod()],
      controlPlaneHourlyRate: 0.1,
    });
    const rows = allocationToCostRows(result, RANGE);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.service).toBe(SERVICE_CONTROL_PLANE);
  });

  it("is deterministic across identical runs", () => {
    const build = () =>
      allocateClusterCost({
        nodes: [node()],
        pods: [pod()],
        volumes: [volume(), volume({ name: "orphan", mountedBy: [] })],
        loadBalancers: [loadBalancer()],
        controlPlaneHourlyRate: 0.1,
      });
    expect(allocationToCostRows(build(), RANGE)).toEqual(allocationToCostRows(build(), RANGE));
  });
});
