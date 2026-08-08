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
 *  - `service` is a small stable set (`kubernetes-workload`, `kubernetes-idle`,
 *    `kubernetes-system-reserved`) rather than one value per namespace, so the
 *    service breakdown stays a legible four-way split.
 *  - `resourceId` is the workload identity `namespace/Kind/name`, which the
 *    cost model already guarantees is stable across runs.
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
export const SERVICE_SYSTEM_RESERVED = "kubernetes-system-reserved";

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
export function snapshotDay(range: CostFetchRange): string {
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
  if (allocation.pricedNodeCount === 0) return [];

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
    push(
      SERVICE_WORKLOAD,
      workload.key,
      tagsFor(workload.namespace, workload.workload, workload.workloadKind),
      workload.dailyCost,
    );
  }

  // Idle and system-reserved are their own rows, never spread across the
  // namespaces. A namespace's number has to mean "what this namespace asked
  // for"; folding the cluster's spare capacity into it overcharges the tenant
  // and hides the real finding, which is that the cluster is oversized.
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
