/**
 * `computeClusterCost` against a fake cluster that also serves PVCs and
 * Services — the wiring from live API objects through attribution to money.
 */

import { describe, it, expect } from "vitest";

import { computeClusterCost } from "../cluster-cost.js";
import {
  EMPTY_RATE_TABLE,
  hasAnyRate,
  loadBalancerRate,
  parseNodeRates,
  storageRate,
} from "../node-rates.js";
import type { K8sFetch } from "../shared.js";

const RATES = parseNodeRates(
  JSON.stringify({
    currency: "USD",
    source: "billed",
    byInstanceType: { "m5.xlarge": 1 },
    controlPlaneHourly: 0.1,
    loadBalancerHourly: 0.025,
    storageGiBMonth: { "*": 0.1, gp3: 0.08 },
  }),
);

const NODES = {
  items: [
    {
      metadata: {
        name: "node-a",
        uid: "u1",
        creationTimestamp: "2026-01-01T00:00:00Z",
        labels: { "node.kubernetes.io/instance-type": "m5.xlarge" },
      },
      status: {
        capacity: { cpu: "4", memory: "16Gi" },
        allocatable: { cpu: "4", memory: "16Gi" },
      },
    },
  ],
};

const PODS = {
  items: [
    {
      metadata: {
        name: "web-abc-1",
        namespace: "app",
        uid: "p1",
        creationTimestamp: "2026-01-01T00:00:00Z",
        labels: { "pod-template-hash": "abc", app: "web" },
        ownerReferences: [{ kind: "ReplicaSet", name: "web-abc", controller: true }],
      },
      spec: {
        nodeName: "node-a",
        containers: [
          { name: "c", image: "i", resources: { requests: { cpu: "500m", memory: "1Gi" } } },
        ],
        volumes: [
          { name: "d", persistentVolumeClaim: { claimName: "web-data" } },
          // A ConfigMap volume must not be mistaken for a claim.
          { name: "cfg", configMap: { name: "settings" } },
        ],
      },
      status: { phase: "Running" },
    },
  ],
};

const CLAIMS = {
  items: [
    {
      // Mounted by the web Deployment, and provisioned larger than requested.
      metadata: { name: "web-data", namespace: "app", uid: "c1", creationTimestamp: "x" },
      spec: { storageClassName: "gp3", resources: { requests: { storage: "90Gi" } } },
      status: { phase: "Bound", capacity: { storage: "100Gi" } },
    },
    {
      // A StatefulSet scaled to zero left this behind: bound, mounted by
      // nothing, billing.
      metadata: { name: "data-db-2", namespace: "app", uid: "c2", creationTimestamp: "x" },
      spec: { storageClassName: "gp3", resources: { storage: "50Gi" } },
      status: { phase: "Bound", capacity: { storage: "50Gi" } },
    },
    {
      // Never bound — no volume exists to charge for.
      metadata: { name: "waiting", namespace: "app", uid: "c3", creationTimestamp: "x" },
      spec: { resources: { requests: { storage: "20Gi" } } },
      status: { phase: "Pending" },
    },
  ],
};

const SERVICES = {
  items: [
    {
      metadata: { name: "web-lb", namespace: "app", uid: "s1", creationTimestamp: "x" },
      spec: { type: "LoadBalancer", selector: { app: "web" } },
      status: { loadBalancer: { ingress: [{ ip: "203.0.113.7" }] } },
    },
    {
      // ClusterIP: not a cloud load balancer, must not be counted.
      metadata: { name: "web-internal", namespace: "app", uid: "s2", creationTimestamp: "x" },
      spec: { type: "ClusterIP", selector: { app: "web" }, clusterIP: "10.0.0.5" },
    },
    {
      // Provisioning has not completed — counted, not charged.
      metadata: { name: "pending-lb", namespace: "app", uid: "s3", creationTimestamp: "x" },
      spec: { type: "LoadBalancer", selector: { app: "nothing" } },
      status: { loadBalancer: {} },
    },
  ],
};

function fakeCluster(opts: { claims?: boolean; services?: boolean } = {}): K8sFetch {
  const { claims = true, services = true } = opts;
  return async function k8sFetch<T>(path: string): Promise<T> {
    if (path === "/api/v1/nodes") return NODES as T;
    if (path === "/api/v1/pods") return PODS as T;
    if (path === "/api/v1/persistentvolumeclaims") {
      if (!claims) throw new Error("K8s API error 403 at https://x: Forbidden");
      return CLAIMS as T;
    }
    if (path === "/api/v1/services") {
      if (!services) throw new Error("K8s API error 403 at https://x: Forbidden");
      return SERVICES as T;
    }
    if (path.startsWith("/apis/metrics.k8s.io/")) {
      throw new Error(`K8s API error 404 at https://x${path}: {"reason":"NotFound"}`);
    }
    throw new Error(`unexpected path ${path}`);
  };
}

describe("rate table extensions", () => {
  it("parses the non-compute prices out of the JSON payload", () => {
    expect(RATES.controlPlaneHourly).toBe(0.1);
    expect(loadBalancerRate(RATES, "app", "anything")).toBe(0.025);
    expect(storageRate(RATES, "gp3")).toBe(0.08);
    expect(storageRate(RATES, "unheard-of")).toBe(0.1);
    expect(storageRate(RATES, "")).toBe(0.1);
  });

  it("parses them out of the hand-typed form too", () => {
    const table = parseNodeRates(
      "m5.large=0.096\ncontrolPlane=0.10, loadBalancer=0.0149\nstorage/*=0.10, storage/gp3=0.08",
    );
    expect(table.byInstanceType).toEqual({ "m5.large": 0.096 });
    expect(table.controlPlaneHourly).toBe(0.1);
    expect(table.loadBalancerHourly).toBe(0.0149);
    expect(storageRate(table, "gp3")).toBe(0.08);
    // Reserved keys must not leak into the instance-type map, or a node would
    // be priced by them.
    expect(table.byInstanceType["controlPlane"]).toBeUndefined();
    expect(table.byInstanceType["storage/gp3"]).toBeUndefined();
  });

  it("lets a per-service entry override the flat rate, including with zero", () => {
    const table = parseNodeRates(
      JSON.stringify({
        loadBalancerHourly: 0.025,
        loadBalancerByService: { "kube-system/mlb": 0 },
      }),
    );
    expect(loadBalancerRate(table, "kube-system", "mlb")).toBe(0);
    expect(loadBalancerRate(table, "app", "other")).toBe(0.025);
  });

  it("still degrades to an empty table on junk, with the new fields empty", () => {
    expect(parseNodeRates("{nope")).toEqual(EMPTY_RATE_TABLE);
    expect(hasAnyRate(EMPTY_RATE_TABLE)).toBe(false);
    expect(storageRate(EMPTY_RATE_TABLE, "gp3")).toBeUndefined();
    expect(loadBalancerRate(EMPTY_RATE_TABLE, "app", "lb")).toBeUndefined();
  });
});

describe("computeClusterCost with storage and load balancers", () => {
  it("prices a claim off status.capacity, not the smaller request", () => {
    return computeClusterCost(fakeCluster(), RATES).then(({ allocation }) => {
      const claim = allocation.storage.volumes.find((v) => v.name === "web-data")!;
      expect(claim.gib).toBe(100);
      expect(claim.capacityBasis).toBe("provisioned");
      expect(claim.workload).toBe("web");
      expect(claim.workloadKind).toBe("Deployment");
    });
  });

  it("classifies the left-behind and the never-bound claims apart", async () => {
    const { allocation } = await computeClusterCost(fakeCluster(), RATES);

    const orphan = allocation.storage.volumes.find((v) => v.name === "data-db-2")!;
    expect(orphan.unattached).toBe(true);
    expect(orphan.hourlyCost).toBeGreaterThan(0);

    const waiting = allocation.storage.volumes.find((v) => v.name === "waiting")!;
    expect(waiting.unbound).toBe(true);
    expect(waiting.capacityBasis).toBe("requested");
    expect(waiting.hourlyCost).toBeNull();

    expect(allocation.storage.unattachedCount).toBe(1);
    expect(allocation.storage.unboundCount).toBe(1);
  });

  it("counts only LoadBalancer Services, and only charges provisioned ones", async () => {
    const { allocation } = await computeClusterCost(fakeCluster(), RATES);

    expect(allocation.loadBalancers.count).toBe(2);
    expect(allocation.loadBalancers.provisionedCount).toBe(1);
    expect(allocation.loadBalancers.hourlyCost).toBe(0.025);

    const web = allocation.loadBalancers.loadBalancers.find((lb) => lb.name === "web-lb")!;
    expect(web.workload).toBe("web");
    const pending = allocation.loadBalancers.loadBalancers.find((lb) => lb.name === "pending-lb")!;
    expect(pending.pending).toBe(true);
    expect(pending.hourlyCost).toBeNull();
  });

  it("ignores a ConfigMap volume when looking for claim names", async () => {
    const { allocation } = await computeClusterCost(fakeCluster(), RATES);
    // Exactly one claim resolved to the web Deployment; `settings` is not one.
    const attributed = allocation.storage.volumes.filter((v) => v.workload === "web");
    expect(attributed.map((v) => v.name)).toEqual(["web-data"]);
  });

  it("includes the control-plane fee as its own bucket", async () => {
    const { allocation } = await computeClusterCost(fakeCluster(), RATES);
    expect(allocation.hourlyControlPlaneCost).toBe(0.1);
    expect(allocation.hourlyNodeCost).toBe(1);
    expect(allocation.hourlyTotalCost).toBeGreaterThan(allocation.hourlyNodeCost!);
  });

  it("still produces the full compute allocation when PVCs are forbidden", async () => {
    const result = await computeClusterCost(fakeCluster({ claims: false }), RATES);

    expect(result.extrasUnavailable).toBe(true);
    expect(result.allocation.storage.count).toBe(0);
    // Compute is untouched — one forbidden list must not cost the whole pane.
    expect(result.allocation.pricedNodeCount).toBe(1);
    expect(result.allocation.workloads.find((w) => w.workload === "web")).toBeDefined();
    // And the load balancers still came through.
    expect(result.allocation.loadBalancers.count).toBe(2);
  });

  it("reports no storage rather than zero storage when the list is unavailable", async () => {
    const result = await computeClusterCost(fakeCluster({ claims: false, services: false }), RATES);
    expect(result.extrasUnavailable).toBe(true);
    expect(result.allocation.storage.hourlyAttributedCost).toBeNull();
    expect(result.allocation.loadBalancers.hourlyCost).toBeNull();
  });
});
