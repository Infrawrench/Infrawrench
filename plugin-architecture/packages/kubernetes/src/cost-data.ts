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
 *  - `service` is a small stable set — `kubernetes-workload`, `kubernetes-idle`,
 *    `kubernetes-system-reserved`, `kubernetes-control-plane`,
 *    `kubernetes-storage`, `kubernetes-storage-idle` and
 *    `kubernetes-load-balancer` — rather than one value per namespace, so the
 *    service breakdown stays a legible partition of the cluster's bill. The
 *    labels **partition**: every unit of money appears under exactly one, which
 *    is why a workload's row carries its compute share only and its disks and
 *    load balancers get rows of their own.
 *  - `resourceId` is the object's identity — `namespace/Kind/name` for a
 *    workload, a claim or a Service — which the cost model already guarantees
 *    is stable across runs.
 *
 * Re-running a day must reproduce identical dimension keys or the host's
 * ReplacingMergeTree dedupe inserts duplicates instead of replacing. Every key
 * component here is derived from cluster state and a fixed label set — no
 * timestamps, no iteration order, no `Map` insertion order leaking into a key.
 * The aggregation map is keyed the same way `vercel/src/cost-data.ts` keys
 * its own.
 */

import type { CostFetchRange, CostRow } from "@infrawrench/plugin-base";

import type { ClusterAllocation } from "./cost-model.js";
import { SYSTEM_NAMESPACES } from "./resource-listers.js";

/** Stable service labels. Changing one of these re-keys history — don't. */
export const SERVICE_WORKLOAD = "kubernetes-workload";
export const SERVICE_IDLE = "kubernetes-idle";
const SERVICE_SYSTEM_RESERVED = "kubernetes-system-reserved";
/** Attributed PersistentVolumeClaims — a workload's or a namespace's disks. */
export const SERVICE_STORAGE = "kubernetes-storage";
/** Bound volumes nothing mounts. Idle capacity in disk form, own bucket. */
export const SERVICE_STORAGE_IDLE = "kubernetes-storage-idle";
/** `LoadBalancer` Services, one row each. */
export const SERVICE_LOAD_BALANCER = "kubernetes-load-balancer";
/** The flat managed-cluster fee. Never divided across tenants. */
export const SERVICE_CONTROL_PLANE = "kubernetes-control-plane";

/**
 * Which day a snapshot describes.
 *
 * A cluster has no history: `/api/v1/pods` says what is running *now*, not
 * what ran last Tuesday. So a collection pass can only honestly date its rows
 * to the most recent day in the requested range — today, in the normal case.
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

/**
 * Turn one cluster allocation into cost rows for a single day.
 *
 * Returns `[]` when nothing could be priced — writing zero-amount rows would
 * assert "this cluster costs nothing", which is a different and false claim
 * from "we don't know what this cluster costs".
 */
export function allocationToCostRows(
  allocation: ClusterAllocation,
  range: CostFetchRange,
): CostRow[] {
  const date = snapshotDay(range);
  const currency = allocation.currency;

  // Aggregate by (service, resourceId, tag set) so re-running reproduces the
  // same keys regardless of pod churn within a workload.
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
    const key = `${service}|${resourceId}`;
    const existing = buckets.get(key);
    if (existing) existing.amount += amount;
    else buckets.set(key, { service, resourceId, tags, amount });
  };

  for (const workload of allocation.workloads) {
    // Deliberately the COMPUTE share, not the workload's total: its volumes and
    // load balancers get their own service rows below, and adding them here as
    // well would double-count the same money under two service labels.
    push(
      SERVICE_WORKLOAD,
      workload.key,
      tagsFor(workload.namespace, workload.workload, workload.workloadKind),
      workload.computeDailyCost,
    );
  }

  // Storage, one row per claim. Attributed to the workload that mounts it where
  // exactly one does, and otherwise to the namespace with an empty workload tag
  // — a shared ReadWriteMany volume genuinely belongs to no single workload,
  // and splitting it N ways would be an invented apportionment.
  for (const volume of allocation.storage.volumes) {
    if (volume.unbound) continue;
    const resourceId = `${volume.namespace}/PersistentVolumeClaim/${volume.name}`;
    if (volume.unattached) {
      // Its own service, so it never inflates a tenant's namespace total — but
      // the namespace tag is kept, because whoever has to run `kubectl delete
      // pvc` needs to know where to run it.
      push(
        SERVICE_STORAGE_IDLE,
        resourceId,
        tagsFor(volume.namespace, "", "PersistentVolumeClaim"),
        volume.dailyCost,
      );
      continue;
    }
    push(
      SERVICE_STORAGE,
      resourceId,
      tagsFor(volume.namespace, volume.workload ?? "", volume.workloadKind ?? ""),
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
  push(
    SERVICE_IDLE,
    "cluster/idle",
    { namespace: "", workload: "idle", workload_kind: "ClusterCapacity", system: "false" },
    allocation.dailyIdleCost,
  );
  push(
    SERVICE_SYSTEM_RESERVED,
    "cluster/system-reserved",
    {
      namespace: "",
      workload: "system-reserved",
      workload_kind: "ClusterCapacity",
      system: "true",
    },
    allocation.dailySystemReservedCost,
  );
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

  // Sorted so the emitted order is deterministic too — not required for
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
