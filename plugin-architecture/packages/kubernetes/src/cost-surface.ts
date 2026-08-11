/**
 * Turning an allocation into things you can actually put on screen.
 *
 * `PeerPaneSchema` carries grouped pills and nothing else — no charts, no
 * tables, no numeric fields. The only per-item surface it has is `subtitle`
 * (a short string) and `status`. So the derived cost has to be *written into
 * the subtitle*, which means it has to be short enough to read inside a pill.
 * Everything in this module exists to make that trade-off in one place rather
 * than in nine peer-group builders.
 *
 * Pure: an index plus string formatting, no fetching. Unit-testable.
 */

import type {
  ClusterAllocation,
  Efficiency,
  NamespaceAllocation,
  PodAllocation,
  WorkloadAllocation,
} from "./cost-model.js";
import { formatDailyCost, formatEfficiency, isOverRequested, workloadKey } from "./cost-model.js";
import type { RateSource } from "./node-rates.js";
import type { UtilizationStatus } from "./metrics-api.js";
import type { ResourceStatus } from "@infrawrench/plugin-base";

/** Lookup tables keyed the way the listers name things. */
export interface CostIndex {
  cluster: ClusterAllocation;
  currency: string;
  rateSource: RateSource;
  /** No node had a rate — show capacity and efficiency, never a made-up price. */
  unpriced: boolean;
  utilizationAvailable: boolean;
  /** Why utilization is missing, when it is. Drives the peer pane's guidance. */
  utilizationStatus: UtilizationStatus;
  /**
   * When this snapshot was taken, ISO-8601.
   *
   * Stamped once here rather than read from a clock inside the renderers, for
   * two reasons: `renderDetail` is synchronous and would otherwise date the
   * report to the moment of *rendering* rather than of measurement, and a
   * report a user shares has to say when its numbers are from — a cluster
   * snapshot with no timestamp is indistinguishable from a stale one.
   */
  generatedAt: string;
  /** `namespace/name` → pod. */
  pods: Map<string, PodAllocation>;
  /** `namespace/Kind/name` → workload. */
  workloads: Map<string, WorkloadAllocation>;
  /** namespace name → namespace. */
  namespaces: Map<string, NamespaceAllocation>;
}

export function buildCostIndex(
  cluster: ClusterAllocation,
  rateSource: RateSource,
  utilizationStatus: UtilizationStatus,
  generatedAt: string,
): CostIndex {
  const pods = new Map<string, PodAllocation>();
  for (const pod of cluster.pods) pods.set(`${pod.namespace}/${pod.name}`, pod);

  const workloads = new Map<string, WorkloadAllocation>();
  for (const workload of cluster.workloads) workloads.set(workload.key, workload);

  const namespaces = new Map<string, NamespaceAllocation>();
  for (const ns of cluster.namespaces) namespaces.set(ns.namespace, ns);

  return {
    cluster,
    currency: cluster.currency,
    rateSource,
    unpriced: cluster.pricedNodeCount === 0,
    utilizationAvailable: utilizationStatus.available,
    utilizationStatus,
    generatedAt,
    pods,
    workloads,
    namespaces,
  };
}

/** The shape every surface needs from an allocation, whatever its kind. */
interface Costed {
  dailyCost: number | null;
  efficiency: Efficiency;
}

/**
 * The bit appended to a pill subtitle: `· ~$1.80/day · 18% CPU`.
 *
 * Returns `""` when there is nothing honest to say. Deliberately caps at two
 * fragments — a pill is one line, and a subtitle that wraps is worse than a
 * subtitle that omits the memory figure.
 */
export function costSubtitleSuffix(entry: Costed | undefined, currency: string): string {
  if (!entry) return "";
  const parts: string[] = [];
  const money = formatDailyCost(entry.dailyCost, currency);
  if (money) parts.push(money);
  // Only the tighter dimension: two percentages plus a price does not fit.
  const efficiency = tightestEfficiency(entry.efficiency);
  if (efficiency) parts.push(efficiency);
  return parts.length ? ` · ${parts.join(" · ")}` : "";
}

/** The worse of the two efficiency figures — the one worth acting on. */
export function tightestEfficiency(efficiency: Efficiency): string {
  const cpu = efficiency.cpu;
  const memory = efficiency.memory;
  if (cpu == null && memory == null) return "";
  if (cpu == null) return formatEfficiency({ cpu: null, memory });
  if (memory == null) return formatEfficiency({ cpu, memory: null });
  return cpu <= memory
    ? formatEfficiency({ cpu, memory: null })
    : formatEfficiency({ cpu: null, memory });
}

/**
 * Downgrade a pill's status when a workload is demonstrably over-requested.
 *
 * Never *upgrades*: a CrashLoopBackOff pod that also happens to be efficient
 * is still broken, and health beats thrift. Only ever fires when live
 * utilization exists — requests alone prove nothing about waste.
 */
export function applyCostStatus(
  base: ResourceStatus,
  entry: Costed | undefined,
  utilizationAvailable: boolean,
): ResourceStatus {
  if (!utilizationAvailable || !entry) return base;
  if (base !== "healthy") return base;
  return isOverRequested(entry.efficiency) ? "degraded" : base;
}

/** Look up a workload allocation from the fields a lister wrote. */
export function workloadEntry(
  index: CostIndex | undefined,
  namespace: string,
  kind: string,
  name: string,
): WorkloadAllocation | undefined {
  return index?.workloads.get(workloadKey(namespace, kind, name));
}

export function podEntry(
  index: CostIndex | undefined,
  namespace: string,
  name: string,
): PodAllocation | undefined {
  return index?.pods.get(`${namespace}/${name}`);
}

/**
 * The synthetic namespace label for capacity that belongs to nobody. Kept as
 * a constant because it appears in the cluster table, the cost rows and the
 * docs, and all three have to agree.
 */
export const IDLE_BUCKET_LABEL = "(idle · unallocated capacity)";
export const SYSTEM_RESERVED_BUCKET_LABEL = "(system reserved · kubelet)";
/**
 * The managed control-plane fee. A bucket rather than a share, and for a
 * stronger reason than idle: idle capacity *could* be apportioned and we choose
 * not to, whereas a flat per-cluster fee has no per-workload quantity to
 * apportion it by at all. It is the same number for a cluster running one pod
 * as for one running ten thousand.
 */
export const CONTROL_PLANE_BUCKET_LABEL = "(control plane · managed cluster fee)";
/** Bound volumes no running pod mounts — idle capacity, in disk form. */
export const UNATTACHED_STORAGE_BUCKET_LABEL = "(unattached volumes · mounted by nothing)";
