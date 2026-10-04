import { describe, it, expect } from "vitest";

import { computeClusterCost } from "../cluster-cost.js";
import {
  allocationToCostRows,
  SERVICE_IDLE,
  SERVICE_STORAGE,
  SERVICE_WORKLOAD,
} from "../cost-data.js";
import {
  DEFAULT_NODE_LABEL_KEYS,
  DEFAULT_PVC_LABEL_KEYS,
  MAX_LABEL_KEYS,
  discoverLabelKeys,
  isPerNodeLabelKey,
  nodeAttributes,
  nodeCostTags,
  parseLabelKeySetting,
  pvcCostTags,
} from "../cost-labels.js";
import { buildEfficiencyReport, formatEfficiencyReportText } from "../efficiency-report.js";
import { parseNodeRates } from "../node-rates.js";
import { plugin } from "../plugin.js";

const meta = (name: string, labels: Record<string, string>, namespace?: string) => ({
  name,
  uid: name,
  creationTimestamp: "2024-01-01T00:00:00Z",
  labels,
  ...(namespace ? { namespace } : {}),
});

/**
 * Two nodes of one Deployment: one spot, one on-demand, in different pools,
 * plus a claim mounted by the Deployment.
 */
function mixedCluster() {
  const node = (name: string, labels: Record<string, string>) => ({
    metadata: meta(name, {
      "node.kubernetes.io/instance-type": "m5.large",
      "topology.kubernetes.io/zone": "us-east-1a",
      "kubernetes.io/hostname": name,
      ...labels,
    }),
    status: {
      capacity: { cpu: "2", memory: "8Gi" },
      allocatable: { cpu: "2", memory: "8Gi" },
    },
  });
  const nodes = {
    items: [
      node("spot-1", {
        "karpenter.sh/nodepool": "batch",
        "karpenter.sh/capacity-type": "spot",
        team: "data",
      }),
      node("od-1", {
        "eks.amazonaws.com/nodegroup": "general",
        "eks.amazonaws.com/capacityType": "ON_DEMAND",
        team: "platform",
      }),
    ],
  };
  const pod = (name: string, nodeName: string) => ({
    metadata: {
      ...meta(name, { "pod-template-hash": "abc" }, "app"),
      ownerReferences: [{ kind: "ReplicaSet", name: "web-abc", controller: true }],
    },
    spec: {
      nodeName,
      volumes: [{ name: "data", persistentVolumeClaim: { claimName: "data" } }],
      containers: [{ name: "c", image: "i", resources: { requests: { cpu: "1", memory: "2Gi" } } }],
    },
    status: { phase: "Running" },
  });
  const pods = { items: [pod("web-abc-1", "spot-1"), pod("web-abc-2", "od-1")] };
  const claims = {
    items: [
      {
        metadata: meta(
          "data",
          { "app.kubernetes.io/name": "web", "not-allowed": "x", team: "platform" },
          "app",
        ),
        spec: { storageClassName: "gp3", resources: { requests: { storage: "10Gi" } } },
        status: { phase: "Bound", capacity: { storage: "10Gi" } },
      },
    ],
  };

  return async function k8sFetch<T>(path: string): Promise<T> {
    if (path === "/api/v1/nodes") return nodes as T;
    if (path === "/api/v1/pods") return pods as T;
    if (path === "/api/v1/persistentvolumeclaims") return claims as T;
    if (path === "/api/v1/services") return { items: [] } as T;
    if (path.startsWith("/apis/metrics.k8s.io/")) {
      throw new Error(`K8s API error 404 at https://x${path}: {"reason":"NotFound"}`);
    }
    throw new Error(`unexpected path ${path}`);
  };
}

const RATES = parseNodeRates("m5.large=0.096, storage/*=0.10");
const RANGE = { fromDate: "2026-10-04", toDate: "2026-10-04" };

async function labelledRows() {
  const result = await computeClusterCost(mixedCluster(), RATES);
  return {
    result,
    rows: allocationToCostRows(result.allocation, RANGE, {
      nodeLabels: result.nodeLabels,
      claimLabels: result.claimLabels,
      nodeLabelKeys: ["team"],
      pvcLabelKeys: ["app.kubernetes.io/name", "team"],
    }),
  };
}

describe("nodeAttributes", () => {
  it("normalises node pool and capacity type across providers", () => {
    expect(
      nodeAttributes({
        "karpenter.sh/nodepool": "batch",
        "karpenter.sh/capacity-type": "spot",
      }),
    ).toMatchObject({ nodePool: "batch", capacityType: "spot" });
    expect(
      nodeAttributes({
        "eks.amazonaws.com/nodegroup": "ng",
        "eks.amazonaws.com/capacityType": "SPOT",
      }),
    ).toMatchObject({ nodePool: "ng", capacityType: "spot" });
    expect(nodeAttributes({ "cloud.google.com/gke-nodepool": "default-pool" })).toMatchObject({
      nodePool: "default-pool",
      capacityType: "on-demand",
    });
    expect(
      nodeAttributes({
        "cloud.google.com/gke-nodepool": "spot-pool",
        "cloud.google.com/gke-spot": "true",
      }),
    ).toMatchObject({ capacityType: "spot" });
    expect(
      nodeAttributes({
        "kubernetes.azure.com/agentpool": "user1",
        "kubernetes.azure.com/scalesetpriority": "spot",
      }),
    ).toMatchObject({ nodePool: "user1", capacityType: "spot" });
    expect(nodeAttributes({ "doks.digitalocean.com/node-pool": "pool-1" })).toMatchObject({
      nodePool: "pool-1",
      capacityType: "",
    });
    expect(nodeAttributes({ "k8s.scaleway.com/pool-name": "default" }).nodePool).toBe("default");
    expect(nodeAttributes({ nodepool: "ovh-pool" }).nodePool).toBe("ovh-pool");
  });

  it("leaves capacity type unknown when no provider label says", () => {
    expect(nodeAttributes({}).capacityType).toBe("");
  });
});

describe("parseLabelKeySetting", () => {
  it("defaults when blank and records nothing for none", () => {
    expect(parseLabelKeySetting("", DEFAULT_NODE_LABEL_KEYS, "node")).toEqual([
      ...DEFAULT_NODE_LABEL_KEYS,
    ]);
    expect(parseLabelKeySetting(undefined, DEFAULT_PVC_LABEL_KEYS, "pvc")).toEqual([
      ...DEFAULT_PVC_LABEL_KEYS,
    ]);
    expect(parseLabelKeySetting(" none ", DEFAULT_NODE_LABEL_KEYS, "node")).toEqual([]);
  });

  it("dedupes, drops per-node keys and picker leftovers, and caps", () => {
    expect(
      parseLabelKeySetting("team, team,kubernetes.io/hostname,none\nowner", [], "node"),
    ).toEqual(["team", "owner"]);
    const many = Array.from({ length: 50 }, (_, i) => `k${i}`).join(",");
    expect(parseLabelKeySetting(many, [], "pvc")).toHaveLength(MAX_LABEL_KEYS);
  });

  it("recognises per-node identifiers", () => {
    expect(isPerNodeLabelKey("kubernetes.io/hostname")).toBe(true);
    expect(isPerNodeLabelKey("example.com/node-id")).toBe(true);
    expect(isPerNodeLabelKey("doks.digitalocean.com/node-pool-id")).toBe(false);
    expect(isPerNodeLabelKey("team")).toBe(false);
  });
});

describe("tag builders", () => {
  it("writes normalised node attributes plus allowlisted raw labels", () => {
    expect(
      nodeCostTags(
        {
          "node.kubernetes.io/instance-type": "m5.large",
          "topology.kubernetes.io/zone": "us-east-1a",
          "karpenter.sh/nodepool": "batch",
          "karpenter.sh/capacity-type": "spot",
          team: "data",
          other: "ignored",
        },
        ["team", "absent"],
      ),
    ).toEqual({
      instance_type: "m5.large",
      zone: "us-east-1a",
      node_pool: "batch",
      capacity_type: "spot",
      "k8s_node_label:team": "data",
    });
  });

  it("writes storage class plus allowlisted claim labels", () => {
    expect(pvcCostTags({ team: "x", other: "y" }, "gp3", ["team"])).toEqual({
      storage_class: "gp3",
      "k8s_pvc_label:team": "x",
    });
    expect(pvcCostTags({}, "", [])).toEqual({});
  });
});

describe("allocationToCostRows with labels", () => {
  it("splits a workload's compute by the node it ran on, without changing the total", async () => {
    const { result, rows } = await labelledRows();
    const web = rows.filter((r) => r.service === SERVICE_WORKLOAD);
    expect(web).toHaveLength(2);
    expect(web.every((r) => r.resourceId === "app/Deployment/web")).toBe(true);
    expect(web.map((r) => r.tags!["capacity_type"]).sort()).toEqual(["on-demand", "spot"]);
    expect(web.map((r) => r.tags!["node_pool"]).sort()).toEqual(["batch", "general"]);
    expect(web.map((r) => r.tags!["k8s_node_label:team"]).sort()).toEqual(["data", "platform"]);
    expect(web.every((r) => !("k8s_node_label:kubernetes.io/hostname" in r.tags!))).toBe(true);

    const unlabelled = allocationToCostRows(result.allocation, RANGE);
    const sum = (rs: typeof rows) => rs.reduce((acc, r) => acc + r.amount, 0);
    expect(sum(rows)).toBeCloseTo(sum(unlabelled), 9);
    expect(sum(web)).toBeCloseTo(sum(unlabelled.filter((r) => r.service === SERVICE_WORKLOAD)), 9);
  });

  it("writes idle capacity per node shape", async () => {
    const { rows } = await labelledRows();
    const idle = rows.filter((r) => r.service === SERVICE_IDLE);
    expect(idle.map((r) => r.tags!["node_pool"]).sort()).toEqual(["batch", "general"]);
    expect(idle.every((r) => r.resourceId === "cluster/idle")).toBe(true);
  });

  it("carries claim labels and storage class on the volume row", async () => {
    const { rows } = await labelledRows();
    const volume = rows.find((r) => r.service === SERVICE_STORAGE)!;
    expect(volume.tags).toMatchObject({
      storage_class: "gp3",
      "k8s_pvc_label:app.kubernetes.io/name": "web",
      "k8s_pvc_label:team": "platform",
    });
    expect(volume.tags!["k8s_pvc_label:not-allowed"]).toBeUndefined();
  });

  it("reproduces identical keys on a re-run", async () => {
    const a = (await labelledRows()).rows;
    const b = (await labelledRows()).rows;
    const key = (rs: typeof a) =>
      rs.map((r) => `${r.service}|${r.resourceId}|${JSON.stringify(r.tags)}`);
    expect(key(a)).toEqual(key(b));
  });
});

describe("efficiency report node groups", () => {
  it("groups capacity by pool and capacity type", async () => {
    const { result } = await labelledRows();
    const attrs = new Map(
      [...result.nodeLabels].map(([name, labels]) => [name, nodeAttributes(labels)]),
    );
    const report = buildEfficiencyReport(
      result.allocation,
      "2026-10-04T00:00:00Z",
      undefined,
      attrs,
    );
    expect(report.nodeGroups.map((g) => `${g.label}/${g.capacityType}`).sort()).toEqual([
      "batch/spot",
      "general/on-demand",
    ]);
    for (const group of report.nodeGroups) {
      expect(group.nodeCount).toBe(1);
      expect(group.instanceTypes).toBe("m5.large");
      expect(group.dailyNodeCost).toBeCloseTo(0.096 * 24, 9);
      expect(group.idleShare).not.toBeNull();
    }
    expect(formatEfficiencyReportText(report, "t")).toContain("BY NODE GROUP");
  });

  it("omits node groups from a namespace-scoped report", async () => {
    const { result } = await labelledRows();
    const attrs = new Map(
      [...result.nodeLabels].map(([name, labels]) => [name, nodeAttributes(labels)]),
    );
    expect(buildEfficiencyReport(result.allocation, "x", "app", attrs).nodeGroups).toEqual([]);
  });
});

describe("label-key picker", () => {
  it("lists label keys by frequency, without per-node identifiers", () => {
    const options = discoverLabelKeys(
      [
        { metadata: { labels: { team: "a", "kubernetes.io/hostname": "n1", zone: "z" } } },
        { metadata: { labels: { team: "b", "kubernetes.io/hostname": "n2" } } },
      ],
      "node",
    );
    expect(options.map((o) => o.id)).toEqual(["team", "zone"]);
    expect(options[0]!.description).toContain("2 of 2 nodes");
  });

  it("offers the cluster's keys through the plugin, with none first", async () => {
    const paths: string[] = [];
    const services = {
      k8s: {
        command: async (_op: string, params: { path: string }) => {
          paths.push(params.path);
          return { items: [{ metadata: { labels: { team: "a" } } }] };
        },
      },
    } as never;
    const nodeOptions = await plugin.listCredentialOptions!(
      "costNodeLabelKeys",
      { kubeconfig: "apiVersion: v1" },
      services,
    );
    expect(nodeOptions.map((o) => o.id)).toEqual(["none", "team"]);
    await plugin.listCredentialOptions!("costPvcLabelKeys", { kubeconfig: "x" }, services);
    expect(paths).toEqual(["/api/v1/nodes", "/api/v1/persistentvolumeclaims"]);
    await expect(plugin.listCredentialOptions!("kubeconfig", { kubeconfig: "x" })).rejects.toThrow(
      /no options/,
    );
  });
});
