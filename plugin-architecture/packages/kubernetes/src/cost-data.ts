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
import { nodeCostTags, pvcCostTags } from "./cost-labels.js";

/**
 * Labels to attach to the rows, and which keys of them are allowed through.
 * Optional: without it the rows carry the namespace/workload tags only.
 */
export interface CostRowLabelContext {
  /** Node name → labels. */
  nodeLabels: Map<string, Record<string, string>>;
  /** `namespace/claim` → labels. */
  claimLabels: Map<string, Record<string, string>>;
  nodeLabelKeys: readonly string[];
  pvcLabelKeys: readonly string[];
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

/** A row's GPU model tag: one model, or `mixed` across several. */
function modelTag(models: Set<string>): string {
  if (models.size === 0) return "";
  return models.size === 1 ? [...models][0]! : "mixed";
}

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

  // Aggregate by (service, resourceId, tag set) so re-running reproduces the
  // same keys regardless of pod churn within a workload. The tag set is part
  // of the key because node labels split one workload into several rows.
  const buckets = new Map<
    string,
    { service: string; resourceId: string; tags: Record<string, string>; amount: number }
  >();

  const push = (
    service: string,
    resourceId: string,
    tags: Record<string, string>,
    amount: number | null,
  ) => {
    if (amount == null || !Number.isFinite(amount) || amount === 0) return;
    const key = `${service}|${resourceId}|${canonicalTags(tags)}`;
    const existing = buckets.get(key);
    if (existing) existing.amount += amount;
    else buckets.set(key, { service, resourceId, tags, amount });
  };

  // GPU model per workload, from the nodes its GPU pods landed on.
  const gpuModels = new Map<string, Set<string>>();
  for (const pod of allocation.pods) {
    if (pod.gpus <= 0) continue;
    const key = `${pod.namespace}/${pod.workloadKind}/${pod.workload}`;
    const set = gpuModels.get(key) ?? new Set<string>();
    if (pod.gpuModel) set.add(pod.gpuModel);
    gpuModels.set(key, set);
  }

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

  // Deliberately the CPU/memory COMPUTE share, not the workload's total: its
  // GPUs, volumes and load balancers get their own service rows below, and
  // adding them here as well would double-count the same money under two
  // service labels.
  if (labels) {
    // Per pod, so each share of compute carries the shape of the node it was
    // bought from. A pod's `dailyCost` is CPU + memory + GPU, so its GPU part
    // comes off here (it is the GPU row's); summing a workload's pods then
    // reproduces its `computeDailyCost` exactly. Unplaced pods are unpriced
    // and contribute nothing either way.
    for (const pod of allocation.pods) {
      push(
        SERVICE_WORKLOAD,
        workloadKey(pod.namespace, pod.workloadKind, pod.workload),
        {
          ...tagsFor(pod.namespace, pod.workload, pod.workloadKind),
          ...tagsForNode(pod.nodeName),
        },
        pod.dailyCost == null ? null : pod.dailyCost - (pod.gpuDailyCost ?? 0),
      );
    }
  } else {
    for (const workload of allocation.workloads) {
      push(
        SERVICE_WORKLOAD,
        workload.key,
        tagsFor(workload.namespace, workload.workload, workload.workloadKind),
        workload.computeDailyCost,
      );
    }
  }

  for (const workload of allocation.workloads) {
    if (workload.gpus > 0) {
      push(
        SERVICE_GPU,
        workload.key,
        {
          ...tagsFor(workload.namespace, workload.workload, workload.workloadKind),
          gpu_model: modelTag(gpuModels.get(workload.key) ?? new Set()),
        },
        workload.gpuDailyCost,
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
      {
        namespace: "",
        workload: "gpu-idle",
        workload_kind: "ClusterCapacity",
        system: "false",
        gpu_model: node.gpu.inventory.model,
        ...tagsForNode(node.name),
      },
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
        { ...tagsFor(volume.namespace, "", "PersistentVolumeClaim"), ...claimTags },
        volume.dailyCost,
      );
      continue;
    }
    push(
      SERVICE_STORAGE,
      resourceId,
      {
        ...tagsFor(volume.namespace, volume.workload ?? "", volume.workloadKind ?? ""),
        ...claimTags,
      },
      volume.dailyCost,
    );
  }

  // Load balancers, one row per Service.
  for (const lb of allocation.loadBalancers.loadBalancers) {
    push(
      SERVICE_LOAD_BALANCER,
      `${lb.namespace}/Service/${lb.name}`,
      tagsFor(lb.namespace, lb.workload ?? "", lb.workloadKind ?? ""),
      lb.dailyCost,
    );
  }

  // Idle, system-reserved and the control plane are their own rows, never
  // spread across the namespaces. A namespace's number has to mean "what this
  // namespace asked for"; folding the cluster's spare capacity into it
  // overcharges the tenant and hides the real finding, which is that the
  // cluster is oversized. The control-plane fee goes further: there is no
  // per-workload quantity to apportion a flat per-cluster charge by at all.
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
  if (labels) {
    // Per node, carrying the node's tags: idle capacity is a property of a
    // node pool (and of spot versus on-demand), which is exactly the axis
    // someone resizes along. Same `resourceId` as the cluster-wide row.
    for (const node of allocation.nodes) {
      const tags = tagsForNode(node.name);
      push(SERVICE_IDLE, "cluster/idle", { ...idleTags, ...tags }, scaleDay(node.hourlyIdleCost));
      push(
        SERVICE_SYSTEM_RESERVED,
        "cluster/system-reserved",
        { ...systemReservedTags, ...tags },
        scaleDay(node.hourlySystemReservedCost),
      );
    }
  } else {
    push(SERVICE_IDLE, "cluster/idle", idleTags, allocation.dailyIdleCost);
    push(
      SERVICE_SYSTEM_RESERVED,
      "cluster/system-reserved",
      systemReservedTags,
      allocation.dailySystemReservedCost,
    );
  }
  push(
    SERVICE_CONTROL_PLANE,
    "cluster/control-plane",
    {
      namespace: "",
      workload: "control-plane",
      workload_kind: "ClusterCapacity",
      system: "true",
    },
    allocation.dailyControlPlaneCost,
  );

  // Sorted so the emitted order is deterministic too, not required for
  // dedupe, but it makes a diff of two runs readable.
  return [...buckets.values()]
    .sort((a, b) => a.service.localeCompare(b.service) || a.resourceId.localeCompare(b.resourceId))
    .map((b) => ({
      date,
      service: b.service,
      resourceId: b.resourceId,
      tags: b.tags,
      currency,
      amount: b.amount,
    }));
}
