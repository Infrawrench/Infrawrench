/**
 * Writing the allocation back as daily cost rows.
 *
 * These are **derived allocations, not billed amounts.** The cluster's real
 * money is invoiced to the cloud account that owns the nodes and is collected
 * from that account's own billing API; what this emits is the same money
 * re-cut by namespace and workload. Anyone summing a Kubernetes account's rows
 * together with its parent cloud account's rows will double-count, which is
 * why the service label says so out loud.
 *
 * Shape decisions forced by `CostRow`:
 *
 *  - There is no namespace dimension, so namespace / workload / workload_kind
 *    ride along as **tags**. The declaration lists `tag` for exactly this.
 *  - `service` is a small stable set: `kubernetes-workload`, `kubernetes-idle`,
 *    `kubernetes-system-reserved`, `kubernetes-control-plane`,
 *    `kubernetes-storage`, `kubernetes-storage-idle`,
 *    `kubernetes-load-balancer`, `kubernetes-gpu` and `kubernetes-gpu-idle`,
 *    rather than one value per namespace, so the
 *    service breakdown stays a legible partition of the cluster's bill. The
 *    labels **partition**: every unit of money appears under exactly one, which
 *    is why a workload's row carries its compute share only and its disks and
 *    load balancers get rows of their own.
 *  - `resourceId` is the object's identity (`namespace/Kind/name` for a
 *    workload, a claim or a Service) which the cost model already guarantees
 *    is stable across runs.
 *
 * Node and claim labels (see `cost-labels.ts`) also ride along as tags when
 * the caller passes a {@link CostRowLabelContext}. Node labels *split* rows: a
 * workload whose pods run on spot and on-demand nodes writes one compute row
 * per distinct node-tag set, under the same `resourceId`, and idle and
 * system-reserved capacity are written per node-tag set too, so "idle spot
 * capacity in pool gpu-a" is a query rather than a guess. The money is
 * unchanged: the rows still partition the cluster's bill exactly.
 *
 * Every row also says **what kind of capacity** its money bought and **whether
 * it was used**, in two reserved tags, so an efficiency report can be a query
 * over stored rows rather than a live call into the cluster:
 *
 *  - `k8s_resource`: `cpu`, `memory`, `gpu`, `storage`, `network` (load
 *    balancers) or `control_plane`. A workload's compute share is written as
 *    separate CPU and memory rows, each from its own pool.
 *  - `k8s_usage`: `used` (capacity a pod measurably used, priced through the
 *    same pools as its charge), `unused` (requested but measured unused: the
 *    gap between `max(request, usage)` and usage), `unmeasured` (allocated, no
 *    usage data: never read as either of the other two), `idle` (capacity no
 *    pod requested, unrequested GPUs and unattached volumes) and `overhead`
 *    (system-reserved capacity and the control-plane fee). A mounted volume
 *    and a provisioned load balancer count as `used`: attachment is the usage
 *    signal the API gives for them.
 *
 * Pod labels ride along under `k8s_pod_label:<key>` on compute and GPU rows,
 * for the keys the account's allowlist names (see `cost-labels.ts`), and rows
 * derived from a node carry its region (the cluster's single region on
 * cluster-level rows, when every node agrees on one).
 *
 * Re-running a day must reproduce identical dimension keys or the host's
 * ReplacingMergeTree dedupe inserts duplicates instead of replacing. Every key
 * component here is derived from cluster state and a fixed label set: no
 * timestamps, no iteration order, no `Map` insertion order leaking into a key.
 * The aggregation map is keyed the same way `vercel/src/cost-data.ts` keys
 * its own.
 */

import type { CostFetchRange, CostRow } from "@infrawrench/plugin-base";

import { HOURS_PER_DAY, workloadKey, type ClusterAllocation } from "./cost-model.js";
import { SYSTEM_NAMESPACES } from "./resource-listers.js";
import { namespacedKey } from "./attribution.js";
import { nodeCostTags, podCostTags, pvcCostTags } from "./cost-labels.js";

/**
 * Labels to attach to the rows, and which keys of them are allowed through.
 * Optional: without it the rows carry the namespace/workload tags only.
 */
export interface CostRowLabelContext {
  /** Node name → labels. */
  nodeLabels: Map<string, Record<string, string>>;
  /** `namespace/claim` → labels. */
  claimLabels: Map<string, Record<string, string>>;
  /** `namespace/pod` → labels. Optional so older callers keep working. */
  podLabels?: Map<string, Record<string, string>> | undefined;
  nodeLabelKeys: readonly string[];
  pvcLabelKeys: readonly string[];
  podLabelKeys?: readonly string[] | undefined;
}

/** A stable string for a tag map, independent of insertion order. */
function canonicalTags(tags: Record<string, string>): string {
  return JSON.stringify(Object.entries(tags).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Stable service labels. Changing one of these re-keys history: don't. */
export const SERVICE_WORKLOAD = "kubernetes-workload";
export const SERVICE_IDLE = "kubernetes-idle";
const SERVICE_SYSTEM_RESERVED = "kubernetes-system-reserved";
/** Attributed PersistentVolumeClaims: a workload's or a namespace's disks. */
export const SERVICE_STORAGE = "kubernetes-storage";
/** Bound volumes nothing mounts. Idle capacity in disk form, own bucket. */
export const SERVICE_STORAGE_IDLE = "kubernetes-storage-idle";
/** `LoadBalancer` Services, one row each. */
export const SERVICE_LOAD_BALANCER = "kubernetes-load-balancer";
/** The flat managed-cluster fee. Never divided across tenants. */
export const SERVICE_CONTROL_PLANE = "kubernetes-control-plane";
/** A workload's share of GPU node price, charged by GPU requests. */
export const SERVICE_GPU = "kubernetes-gpu";
/** GPUs no pod requested, one row per GPU node. Its own bucket, like idle. */
export const SERVICE_GPU_IDLE = "kubernetes-gpu-idle";

/** Tag naming the kind of capacity a row's money bought. Re-keys history if renamed. */
export const RESOURCE_TAG = "k8s_resource";
/** Tag naming whether that capacity was used. Re-keys history if renamed. */
export const USAGE_TAG = "k8s_usage";

/** Values of {@link RESOURCE_TAG}. Mirrored in `client-core/src/k8s-efficiency.ts`. */
export type KubernetesCostResource =
  "cpu" | "memory" | "gpu" | "storage" | "network" | "control_plane";
/** Values of {@link USAGE_TAG}. Mirrored in `client-core/src/k8s-efficiency.ts`. */
export type KubernetesUsageState = "used" | "unused" | "unmeasured" | "idle" | "overhead";

/**
 * Which day a snapshot describes.
 *
 * A cluster has no history: `/api/v1/pods` says what is running *now*, not
 * what ran last Tuesday. So a collection pass can only honestly date its rows
 * to the most recent day in the requested range: today, in the normal case.
 * The manifest asks for a 1-day window precisely so the host never requests
 * history this plugin cannot produce; each daily run appends one more day and
 * the series builds up over time.
 */
function snapshotDay(range: CostFetchRange): string {
  return range.toDate;
}

function tagsFor(
  namespace: string,
  workload: string,
  workloadKind: string,
): Record<string, string> {
  return {
    namespace,
    workload,
    workload_kind: workloadKind,
    // kube-system's spend is real and lands on the same nodes as everything
    // else. The workload listings hide the control-plane namespaces for
    // readability; cost allocation must not inherit that, or their money
    // silently disappears and every other namespace looks proportionally
    // bigger than it is. They are included and flagged, never dropped.
    system: SYSTEM_NAMESPACES.has(namespace) ? "true" : "false",
  };
}

function scaleDay(hourly: number | null): number | null {
  return hourly == null ? null : hourly * HOURS_PER_DAY;
}

/**
 * Turn one cluster allocation into cost rows for a single day.
 *
 * Returns `[]` when nothing could be priced: writing zero-amount rows would
 * assert "this cluster costs nothing", which is a different and false claim
 * from "we don't know what this cluster costs".
 */
export function allocationToCostRows(
  allocation: ClusterAllocation,
  range: CostFetchRange,
  labels?: CostRowLabelContext,
): CostRow[] {
  const date = snapshotDay(range);
  const currency = allocation.currency;

  // Aggregate by (service, resourceId, region, tag set) so re-running
  // reproduces the same keys regardless of pod churn within a workload. The
  // tag set is part of the key because node and pod labels, and the resource
  // and usage tags, split one workload into several rows.
  const buckets = new Map<
    string,
    {
      service: string;
      resourceId: string;
      region: string;
      tags: Record<string, string>;
      amount: number;
    }
  >();

  const push = (
    service: string,
    resourceId: string,
    region: string,
    tags: Record<string, string>,
    amount: number | null,
  ) => {
    if (amount == null || !Number.isFinite(amount) || amount === 0) return;
    const key = `${service}|${resourceId}|${region}|${canonicalTags(tags)}`;
    const existing = buckets.get(key);
    if (existing) existing.amount += amount;
    else buckets.set(key, { service, resourceId, region, tags, amount });
  };

  /**
   * Split one charge into its used and unused parts. `wasted` null means no
   * usage data, which is `unmeasured`, never `used`: a pod nobody measured is
   * not thereby efficient. Waste is clamped to the charge so the two parts
   * always sum to it exactly.
   */
  const pushUsage = (
    service: string,
    resourceId: string,
    region: string,
    tags: Record<string, string>,
    resource: KubernetesCostResource,
    charged: number | null,
    wasted: number | null,
  ) => {
    if (charged == null) return;
    if (wasted == null) {
      push(service, resourceId, region, usageTags(tags, resource, "unmeasured"), charged);
      return;
    }
    const unused = Math.min(charged, Math.max(0, wasted));
    push(service, resourceId, region, usageTags(tags, resource, "used"), charged - unused);
    push(service, resourceId, region, usageTags(tags, resource, "unused"), unused);
  };

  // Node tags, computed once per node rather than once per pod.
  const nodeTagCache = new Map<string, Record<string, string>>();
  const tagsForNode = (nodeName: string): Record<string, string> => {
    if (!labels) return {};
    let tags = nodeTagCache.get(nodeName);
    if (!tags) {
      tags = nodeCostTags(labels.nodeLabels.get(nodeName) ?? {}, labels.nodeLabelKeys);
      nodeTagCache.set(nodeName, tags);
    }
    return tags;
  };
  const nodeRegion = new Map(allocation.nodes.map((n) => [n.name, n.region]));
  const regions = new Set(allocation.nodes.map((n) => n.region));
  // Disks, load balancers and the control plane have no node. When every node
  // agrees on one region it is theirs too; otherwise it is left blank rather
  // than guessed.
  const clusterRegion = regions.size === 1 ? ([...regions][0] ?? "") : "";
  const tagsForPod = (namespace: string, podName: string): Record<string, string> => {
    if (!labels?.podLabels || !labels.podLabelKeys) return {};
    return podCostTags(
      labels.podLabels.get(namespacedKey(namespace, podName)) ?? {},
      labels.podLabelKeys,
    );
  };

  // Compute, per pod, so each share carries the shape of the node it was
  // bought from and the labels of the pod that holds it. CPU and memory are
  // separate rows from separate pools; together they are the pod's
  // `dailyCost - gpuDailyCost`, so a workload's rows still sum to its
  // `computeDailyCost`. Unplaced pods are unpriced and contribute nothing.
  for (const pod of allocation.pods) {
    if (pod.dailyCost == null) continue;
    const resourceId = workloadKey(pod.namespace, pod.workloadKind, pod.workload);
    const region = nodeRegion.get(pod.nodeName) ?? "";
    const tags = {
      ...tagsFor(pod.namespace, pod.workload, pod.workloadKind),
      ...tagsForNode(pod.nodeName),
      ...tagsForPod(pod.namespace, pod.name),
    };
    pushUsage(
      SERVICE_WORKLOAD,
      resourceId,
      region,
      tags,
      "cpu",
      scaleDay(pod.cpuHourlyCost),
      scaleDay(pod.cpuWastedHourlyCost),
    );
    pushUsage(
      SERVICE_WORKLOAD,
      resourceId,
      region,
      tags,
      "memory",
      scaleDay(pod.memoryHourlyCost),
      scaleDay(pod.memoryWastedHourlyCost),
    );
    if (pod.gpus > 0 && pod.gpuDailyCost != null) {
      // The GPU share per pod too, tagged with the model of the node it
      // holds, so used and idle GPU money group by the same node pool as CPU.
      pushUsage(
        SERVICE_GPU,
        resourceId,
        region,
        { ...tags, gpu_model: pod.gpuModel },
        "gpu",
        pod.gpuDailyCost,
        pod.gpuWastedDailyCost,
      );
    }
  }

  // Idle GPUs, per node: a GPU node is the unit someone scales down, and its
  // model is the dimension worth grouping by ("how much idle A100 do we pay
  // for"). Never spread over the namespaces, for the same reason as idle CPU.
  // Node-derived, so it carries the node's tags like idle CPU does.
  for (const node of allocation.nodes) {
    if (!node.gpu) continue;
    push(
      SERVICE_GPU_IDLE,
      `node/${node.name}/gpu-idle`,
      node.region,
      usageTags(
        {
          namespace: "",
          workload: "gpu-idle",
          workload_kind: "ClusterCapacity",
          system: "false",
          gpu_model: node.gpu.inventory.model,
          ...tagsForNode(node.name),
        },
        "gpu",
        "idle",
      ),
      node.gpu.hourlyIdleCost == null ? null : node.gpu.hourlyIdleCost * HOURS_PER_DAY,
    );
  }

  // Storage, one row per claim. Attributed to the workload that mounts it where
  // exactly one does, and otherwise to the namespace with an empty workload tag:
  // a shared ReadWriteMany volume genuinely belongs to no single workload,
  // and splitting it N ways would be an invented apportionment.
  for (const volume of allocation.storage.volumes) {
    if (volume.unbound) continue;
    const resourceId = `${volume.namespace}/PersistentVolumeClaim/${volume.name}`;
    const claimTags = labels
      ? pvcCostTags(
          labels.claimLabels.get(namespacedKey(volume.namespace, volume.name)) ?? {},
          volume.storageClass,
          labels.pvcLabelKeys,
        )
      : {};
    if (volume.unattached) {
      // Its own service, so it never inflates a tenant's namespace total, but
      // the namespace tag is kept, because whoever has to run `kubectl delete
      // pvc` needs to know where to run it.
      push(
        SERVICE_STORAGE_IDLE,
        resourceId,
        clusterRegion,
        usageTags(
          { ...tagsFor(volume.namespace, "", "PersistentVolumeClaim"), ...claimTags },
          "storage",
          "idle",
        ),
        volume.dailyCost,
      );
      continue;
    }
    push(
      SERVICE_STORAGE,
      resourceId,
      clusterRegion,
      usageTags(
        {
          ...tagsFor(volume.namespace, volume.workload ?? "", volume.workloadKind ?? ""),
          ...claimTags,
        },
        "storage",
        "used",
      ),
      volume.dailyCost,
    );
  }

  // Load balancers, one row per Service.
  for (const lb of allocation.loadBalancers.loadBalancers) {
    push(
      SERVICE_LOAD_BALANCER,
      `${lb.namespace}/Service/${lb.name}`,
      clusterRegion,
      usageTags(tagsFor(lb.namespace, lb.workload ?? "", lb.workloadKind ?? ""), "network", "used"),
      lb.dailyCost,
    );
  }

  // Idle, system-reserved and the control plane are their own rows, never
  // spread across the namespaces. A namespace's number has to mean "what this
  // namespace asked for"; folding the cluster's spare capacity into it
  // overcharges the tenant and hides the real finding, which is that the
  // cluster is oversized. The control-plane fee goes further: there is no
  // per-workload quantity to apportion a flat per-cluster charge by at all.
  //
  // Per node, carrying the node's tags when there are any: idle capacity is a
  // property of a node pool (and of spot versus on-demand), which is exactly
  // the axis someone resizes along. Same `resourceId` as the cluster-wide row,
  // and CPU and memory apart, like the pods'.
  const idleTags = {
    namespace: "",
    workload: "idle",
    workload_kind: "ClusterCapacity",
    system: "false",
  };
  const systemReservedTags = {
    namespace: "",
    workload: "system-reserved",
    workload_kind: "ClusterCapacity",
    system: "true",
  };
  for (const node of allocation.nodes) {
    const tags = tagsForNode(node.name);
    for (const [resource, idle, reserved] of [
      ["cpu", node.hourlyIdleCpuCost, node.hourlySystemReservedCpuCost],
      ["memory", node.hourlyIdleMemoryCost, node.hourlySystemReservedMemoryCost],
    ] as const) {
      push(
        SERVICE_IDLE,
        "cluster/idle",
        node.region,
        usageTags({ ...idleTags, ...tags }, resource, "idle"),
        scaleDay(idle),
      );
      push(
        SERVICE_SYSTEM_RESERVED,
        "cluster/system-reserved",
        node.region,
        usageTags({ ...systemReservedTags, ...tags }, resource, "overhead"),
        scaleDay(reserved),
      );
    }
  }
  push(
    SERVICE_CONTROL_PLANE,
    "cluster/control-plane",
    clusterRegion,
    usageTags(
      {
        namespace: "",
        workload: "control-plane",
        workload_kind: "ClusterCapacity",
        system: "true",
      },
      "control_plane",
      "overhead",
    ),
    allocation.dailyControlPlaneCost,
  );

  // Sorted so the emitted order is deterministic too, not required for
  // dedupe, but it makes a diff of two runs readable.
  return [...buckets.values()]
    .sort(
      (a, b) =>
        a.service.localeCompare(b.service) ||
        a.resourceId.localeCompare(b.resourceId) ||
        a.region.localeCompare(b.region) ||
        canonicalTags(a.tags).localeCompare(canonicalTags(b.tags)),
    )
    .map((b) => ({
      date,
      service: b.service,
      resourceId: b.resourceId,
      ...(b.region ? { region: b.region } : {}),
      tags: b.tags,
      currency,
      amount: b.amount,
    }));
}

/** A row's tags plus its resource and usage tags. */
function usageTags(
  tags: Record<string, string>,
  resource: KubernetesCostResource,
  usage: KubernetesUsageState,
): Record<string, string> {
  return { ...tags, [RESOURCE_TAG]: resource, [USAGE_TAG]: usage };
}
