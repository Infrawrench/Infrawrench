/**
 * Kubernetes cost allocation.
 *
 * A cluster has no billing API. Its spend lands on the *cloud* account that
 * owns the nodes, as a line item for a pile of VMs. Everything in this module
 * is therefore **derived**: node capacity, times what that node costs, times
 * each pod's share of it. Nothing here is a billed amount, and the outputs
 * carry that distinction (`basis`, `pricedNodeCount`) so callers can label it.
 *
 * Four things a cluster costs, and where each one goes:
 *
 *  - **Node compute** — split into a CPU and a memory pool, charged to pods by
 *    `max(request, usage)` against node capacity. The remainder becomes the
 *    `idle` and `systemReserved` buckets.
 *  - **Persistent volumes** — a PVC is namespaced and is mounted by pods, so
 *    it is attributable: to the one workload that mounts it, or to its
 *    namespace when several do. A *bound* claim nothing mounts is real money
 *    nobody is using, and gets its own bucket rather than a tenant's bill.
 *  - **Load balancers** — a `Service` of type `LoadBalancer` provisions one
 *    real cloud load balancer. Its selector resolves it to a workload where it
 *    is unambiguous, and to its namespace otherwise.
 *  - **The control plane** — a flat per-cluster fee with no per-workload
 *    component at all. It is not divisible, so it is never divided: it sits
 *    beside `idle` and `systemReserved` as its own line.
 *
 * Egress is deliberately absent. The Kubernetes API exposes no per-workload
 * byte counters — `metrics.k8s.io` carries a `ResourceList` of CPU and memory
 * and nothing else — so any per-namespace network figure would be an invented
 * apportionment. It belongs to flow-log-based attribution, not here.
 *
 * The module is a pure function over plain data — no fetching, no clock, no
 * Kubernetes types. Everything it needs has already been parsed into cores and
 * bytes by `quantity.ts`. That is what makes it testable without a cluster.
 */

import type { ResourcePair } from "./quantity.js";

/**
 * Fraction of a node's price attributed to its CPU; the rest goes to memory.
 *
 * WHY 0.65 AND NOT A ROUND NUMBER: every major cloud that publishes
 * *component* pricing prices vCPU-hours and GiB-hours separately, and a
 * general-purpose instance's price is (vCPUs x vCPU-rate) + (GiB x GiB-rate).
 * Taking the published component rates for the mainstream general-purpose
 * families — which run at roughly 4 GiB of RAM per vCPU — the CPU term is
 * consistently a little under two thirds of the machine price:
 *
 *   - GCP N2 (us-central1, on-demand): $0.031611/vCPU-hr and $0.004237/GiB-hr.
 *     For n2-standard-4 (4 vCPU, 16 GiB): CPU $0.12644, RAM $0.06779
 *     -> CPU share 0.651.
 *   - GCP N2D and E2 land in the same band (0.63-0.66) with the same 4:1
 *     GiB-per-vCPU shape.
 *   - AWS and Azure do not publish a per-component breakdown for EC2 /
 *     Virtual Machines, but their memory-optimised families cost roughly
 *     1.3x their general-purpose equivalents at 2x the RAM, which implies the
 *     same ~2:1 CPU:RAM value split.
 *
 * So 0.65/0.35 is the median of the only published component pricing that
 * exists, not a guess. It is deliberately a *single* constant rather than a
 * per-cloud table: the split only shifts the boundary between two tenants'
 * shares of the same node, so a few points of error moves money between
 * workloads but never changes the cluster total, the idle bucket, or the
 * efficiency figures. Callers that know better can override it per call.
 */
export const DEFAULT_CPU_COST_SHARE = 0.65;

/** Hours in the accounting window a "daily" figure covers. */
export const HOURS_PER_DAY = 24;

/**
 * Hours in a billing month, for converting a per-GiB-**month** disk price into
 * the per-hour terms everything else in this module is expressed in.
 *
 * 730 is not a rounding of 24 x 30. It is 365.25 x 24 / 12 = 730.5 truncated,
 * and it is the convention every major provider's own pricing calculator uses
 * to turn a monthly rate into an hourly one. Using 720 (24 x 30) instead would
 * overstate every disk by 1.4% — small, consistent, and therefore invisible.
 */
export const HOURS_PER_MONTH = 730;

/** A node, already parsed into base units. */
export interface CostModelNode {
  name: string;
  /** Total machine size — what you pay for. */
  capacity: ResourcePair;
  /**
   * What the scheduler may hand to pods. Always <= capacity; the difference is
   * kubelet/system reserved and eviction headroom.
   */
  allocatable: ResourcePair;
  instanceType?: string;
  zone?: string;
  region?: string;
  /**
   * Cost of this whole node for one hour, in the model's currency. Undefined
   * means "we have no rate for this node" — its pods are reported without
   * money rather than with a fabricated number.
   */
  hourlyRate?: number | undefined;
  /** Live usage from metrics.k8s.io, when metrics-server is installed. */
  usage?: ResourcePair | undefined;
}

/** A pod, already parsed into base units. */
export interface CostModelPod {
  name: string;
  namespace: string;
  /** Node the scheduler placed it on. Empty while Pending. */
  nodeName: string;
  /** Owning workload's name — falls back to the pod's own name for bare pods. */
  workload: string;
  /** Deployment | StatefulSet | DaemonSet | Job | CronJob | Pod. */
  workloadKind: string;
  /** Effective pod request (see `effective-requests` in resource-listers). */
  requests: ResourcePair;
  limits: ResourcePair;
  /** Live usage from metrics.k8s.io, when available. */
  usage?: ResourcePair | undefined;
}

/** The workload a non-compute object was resolved to. */
export interface AttributionTarget {
  workload: string;
  workloadKind: string;
}

/**
 * A PersistentVolumeClaim, already resolved to the workloads that mount it.
 *
 * The caller does the resolving because it needs the pod list to do it; this
 * module only decides what the resolution *means* for the money.
 */
export interface CostModelVolume {
  name: string;
  namespace: string;
  /** `Bound` | `Pending` | `Lost`, straight off `status.phase`. */
  phase: string;
  /** StorageClass name. Empty when the claim named none. */
  storageClass: string;
  /** Size in GiB. See {@link capacityBasis} for which size this is. */
  gib: number;
  /**
   * `provisioned` when it came from `status.capacity` — what the provisioner
   * actually made, and therefore what is billed. `requested` when the claim has
   * not bound yet and only `spec.resources.requests` exists.
   */
  capacityBasis: "provisioned" | "requested";
  /** Every distinct workload with a running pod that mounts this claim. */
  mountedBy: AttributionTarget[];
  /** Price per provisioned GiB-month. Undefined means no price for its class. */
  gibMonthRate?: number | undefined;
}

/** A `Service` of type `LoadBalancer`, already resolved to its workload. */
export interface CostModelLoadBalancer {
  name: string;
  namespace: string;
  /**
   * The provisioned address from `status.loadBalancer.ingress`. Empty means the
   * cloud controller has not finished (or cannot) provision it — in which case
   * there is very likely nothing being billed yet, so it is counted but not
   * charged.
   */
  address: string;
  /** `spec.loadBalancerClass`, when a non-default implementation is named. */
  loadBalancerClass: string;
  /** The single workload its selector matched, when exactly one did. */
  target?: AttributionTarget | undefined;
  /** Hourly price of this load balancer, when known. */
  hourlyRate?: number | undefined;
}

export interface CostModelInput {
  nodes: CostModelNode[];
  pods: CostModelPod[];
  /** PersistentVolumeClaims. Omitted entirely when the lister was forbidden. */
  volumes?: CostModelVolume[];
  /** `LoadBalancer` Services. Omitted entirely when the lister was forbidden. */
  loadBalancers?: CostModelLoadBalancer[];
  /**
   * Flat managed-control-plane fee per hour. Undefined for a self-managed
   * cluster, whose control plane is already priced as node compute.
   */
  controlPlaneHourlyRate?: number | undefined;
  /** ISO 4217, for labelling only. Defaults to USD. */
  currency?: string;
  /** Override for {@link DEFAULT_CPU_COST_SHARE}. */
  cpuCostShare?: number;
}

/** How a figure was arrived at. Never hide this from the user. */
export type AllocationBasis = "usage-or-requests" | "requests";

export interface Efficiency {
  /** used / requested, 0..n. `null` when there is nothing to divide by. */
  cpu: number | null;
  memory: number | null;
}

export interface PodAllocation {
  name: string;
  namespace: string;
  nodeName: string;
  workload: string;
  workloadKind: string;
  requests: ResourcePair;
  limits: ResourcePair;
  usage: ResourcePair | null;
  /** What the pod is actually charged for: max(request, usage) per dimension. */
  charged: ResourcePair;
  /** Fraction of the node's CPU / memory capacity this pod holds. */
  cpuShare: number;
  memoryShare: number;
  hourlyCost: number | null;
  dailyCost: number | null;
  efficiency: Efficiency;
  /**
   * Capacity this pod holds but demonstrably does not use: `charged - usage`,
   * floored at zero on each dimension.
   *
   * **`null` when there is no usage data at all.** A pod on a cluster with no
   * metrics-server wastes an unknown amount, which is a different claim from
   * wasting none, and the difference is the whole point of the distinction.
   */
  wasted: ResourcePair | null;
  /** {@link wasted}, priced through the same pools as {@link hourlyCost}. */
  wastedHourlyCost: number | null;
  wastedDailyCost: number | null;
  /**
   * True when the pod names no node, or names a node that is not in the input
   * (drained, deleted, or listed between two API calls). Such a pod is still
   * reported — with its requests — but carries no cost, because there is no
   * machine to take the money from.
   */
  unplaced: boolean;
}

/**
 * The non-compute money attributed to one workload or namespace.
 *
 * Kept as named parts rather than folded into a single figure because they
 * answer different questions and have different fixes: compute waste is a
 * `resources.requests` edit, a disk is a `kubectl delete pvc`, and a load
 * balancer is an ingress consolidation.
 */
export interface CostBreakdown {
  /** Share of node price — the pods' allocation. */
  computeHourlyCost: number | null;
  computeDailyCost: number | null;
  /** Attributed PersistentVolumeClaims. */
  storageHourlyCost: number | null;
  storageDailyCost: number | null;
  /** Attributed `LoadBalancer` Services. */
  loadBalancerHourlyCost: number | null;
  loadBalancerDailyCost: number | null;
  /** Provisioned storage attributed here, in GiB. Shown even when unpriced. */
  storageGib: number;
  /** Load balancers attributed here. Shown even when unpriced. */
  loadBalancerCount: number;
}

export interface WorkloadAllocation extends CostBreakdown {
  /** Stable identity: `namespace/kind/name`. Used as the cost-row key. */
  key: string;
  namespace: string;
  workload: string;
  workloadKind: string;
  podCount: number;
  requests: ResourcePair;
  usage: ResourcePair | null;
  charged: ResourcePair;
  /** Compute + storage + load balancers: everything attributed to this thing. */
  hourlyCost: number | null;
  dailyCost: number | null;
  efficiency: Efficiency;
  /** Compute waste. `null` when this workload has no usage data at all. */
  wasted: ResourcePair | null;
  wastedHourlyCost: number | null;
  wastedDailyCost: number | null;
  /** True when not one of its pods reported usage — "unknown", never "0%". */
  usageUnknown: boolean;
}

export interface NamespaceAllocation extends CostBreakdown {
  namespace: string;
  podCount: number;
  requests: ResourcePair;
  usage: ResourcePair | null;
  charged: ResourcePair;
  hourlyCost: number | null;
  dailyCost: number | null;
  efficiency: Efficiency;
  wasted: ResourcePair | null;
  wastedHourlyCost: number | null;
  wastedDailyCost: number | null;
  usageUnknown: boolean;
}

/** One PersistentVolumeClaim, priced and attributed. */
export interface VolumeAllocation {
  name: string;
  namespace: string;
  storageClass: string;
  phase: string;
  gib: number;
  capacityBasis: "provisioned" | "requested";
  /** The single workload that mounts it, when exactly one does. */
  workload: string | null;
  workloadKind: string | null;
  /** Mounted by more than one workload — charged to the namespace instead. */
  shared: boolean;
  /**
   * Bound to a PersistentVolume, so provisioned and billing, but mounted by no
   * running pod. This is the storage equivalent of idle capacity and it is
   * treated the same way: its own bucket, never a tenant's cost.
   *
   * The common cause is a StatefulSet: its `volumeClaimTemplates` PVCs default
   * to `Retain` on both scale-down and delete, so shrinking or removing a
   * StatefulSet leaves its disks behind, billing, forever, until someone
   * deletes them by hand.
   */
  unattached: boolean;
  /**
   * Never bound (`Pending`, or `Lost`). Reported as a finding with its
   * requested size, and **never priced** — a claim with no PersistentVolume
   * behind it has, as far as anyone can tell from the cluster, provisioned
   * nothing to bill for.
   */
  unbound: boolean;
  hourlyCost: number | null;
  dailyCost: number | null;
}

/** One `LoadBalancer` Service, priced and attributed. */
export interface LoadBalancerAllocation {
  name: string;
  namespace: string;
  address: string;
  loadBalancerClass: string;
  workload: string | null;
  workloadKind: string | null;
  /** No address yet: counted, not charged. */
  pending: boolean;
  hourlyCost: number | null;
  dailyCost: number | null;
}

export interface StorageTotals {
  volumes: VolumeAllocation[];
  /** Every claim, including unbound ones. */
  count: number;
  /** Provisioned GiB across bound claims. */
  gib: number;
  /** Bound but mounted by nothing. */
  unattachedCount: number;
  unattachedGib: number;
  /** Pending or Lost. Counted, never priced. */
  unboundCount: number;
  unboundGib: number;
  /** Attributed to a workload or a namespace. */
  hourlyAttributedCost: number | null;
  dailyAttributedCost: number | null;
  /** The unattached bucket. Its own line, never spread over tenants. */
  hourlyUnattachedCost: number | null;
  dailyUnattachedCost: number | null;
  /** Storage classes we had no price for. Answers "why is this GiB free". */
  unpricedClasses: string[];
}

export interface LoadBalancerTotals {
  loadBalancers: LoadBalancerAllocation[];
  count: number;
  /** Provisioned (has an address) — the ones that can be billing. */
  provisionedCount: number;
  hourlyCost: number | null;
  dailyCost: number | null;
  /** True when at least one provisioned load balancer had no rate. */
  anyUnpriced: boolean;
}

export interface NodeAllocation {
  name: string;
  instanceType: string;
  zone: string;
  region: string;
  capacity: ResourcePair;
  allocatable: ResourcePair;
  /** Sum of what the node's pods are charged for, clamped to capacity. */
  allocated: ResourcePair;
  /** Schedulable capacity nobody is using. */
  idle: ResourcePair;
  /** capacity - allocatable: kubelet/system reserved. Never a tenant's fault. */
  systemReserved: ResourcePair;
  hourlyRate: number | null;
  hourlyAllocatedCost: number | null;
  hourlyIdleCost: number | null;
  hourlySystemReservedCost: number | null;
  podCount: number;
  utilization: ResourcePair | null;
}

export interface ClusterAllocation {
  currency: string;
  cpuCostShare: number;
  /**
   * `usage-or-requests` when at least one pod had live utilization, so the
   * greater-of rule could bite; `requests` when metrics-server was absent and
   * every figure is a request.
   */
  basis: AllocationBasis;
  /** True when every node had a rate — i.e. the money is complete. */
  fullyPriced: boolean;
  pricedNodeCount: number;
  nodeCount: number;
  /** Nodes we had no rate for. Surfaced so "why is this $0" is answerable. */
  unpricedNodes: string[];
  /**
   * Sum of the node rates: what the machines cost, and nothing else.
   *
   * This, not {@link hourlyTotalCost}, is the denominator for "how much of the
   * cluster is idle" — idle is unused *node capacity*, and dividing it by a
   * total that also contains disks and load balancers would silently shrink the
   * percentage every time someone attached a volume.
   */
  hourlyNodeCost: number | null;
  dailyNodeCost: number | null;
  /** Nodes + control plane + storage + load balancers. What the cluster costs. */
  hourlyTotalCost: number | null;
  dailyTotalCost: number | null;
  /** Schedulable-but-unused capacity. Its own line, never spread over tenants. */
  hourlyIdleCost: number | null;
  dailyIdleCost: number | null;
  hourlySystemReservedCost: number | null;
  dailySystemReservedCost: number | null;
  hourlyAllocatedCost: number | null;
  dailyAllocatedCost: number | null;
  /**
   * The managed control-plane fee. Its own bucket for a stronger reason than
   * idle's: idle *could* in principle be apportioned and we choose not to,
   * whereas the control-plane fee has no per-workload component to apportion by
   * in the first place. It is the same number whether the cluster runs one pod
   * or ten thousand.
   */
  hourlyControlPlaneCost: number | null;
  dailyControlPlaneCost: number | null;
  /** Cluster-wide compute waste — held but demonstrably unused. */
  wasted: ResourcePair | null;
  wastedHourlyCost: number | null;
  wastedDailyCost: number | null;
  efficiency: Efficiency;
  storage: StorageTotals;
  loadBalancers: LoadBalancerTotals;
  nodes: NodeAllocation[];
  pods: PodAllocation[];
  workloads: WorkloadAllocation[];
  namespaces: NamespaceAllocation[];
}

const ZERO: ResourcePair = { cpuCores: 0, memoryBytes: 0 };

function add(a: ResourcePair, b: ResourcePair): ResourcePair {
  return { cpuCores: a.cpuCores + b.cpuCores, memoryBytes: a.memoryBytes + b.memoryBytes };
}

function ratio(used: number, requested: number): number | null {
  if (!(requested > 0)) return null;
  return used / requested;
}

/** used/requested for both dimensions, `null` where the denominator is zero. */
function efficiencyOf(usage: ResourcePair | null, requests: ResourcePair): Efficiency {
  if (!usage) return { cpu: null, memory: null };
  return {
    cpu: ratio(usage.cpuCores, requests.cpuCores),
    memory: ratio(usage.memoryBytes, requests.memoryBytes),
  };
}

/** Sum of a nullable-cost list — `null` only when nothing was priced at all. */
function sumCosts(values: Array<number | null>): number | null {
  let total = 0;
  let sawNumber = false;
  for (const v of values) {
    if (v == null) continue;
    total += v;
    sawNumber = true;
  }
  return sawNumber ? total : null;
}

/**
 * Allocate node cost across pods, workloads and namespaces.
 *
 * The rules, in order:
 *
 *  1. A node's hourly rate is split into a CPU pool and a memory pool by
 *     {@link DEFAULT_CPU_COST_SHARE}.
 *  2. Each pod is charged for `max(request, usage)` on each dimension. A pod
 *     that under-requests still consumes the machine, and a pod that requests
 *     and idles still denies that capacity to everyone else — charging the
 *     greater of the two is the only rule that is fair in both directions.
 *  3. A pod's share of a pool is its charged amount over the node's *capacity*
 *     (not allocatable), because capacity is what the invoice is for.
 *  4. If the pods on a node are charged for more than the node has (possible
 *     under overcommit, when live usage exceeds requests), every pod on that
 *     node is scaled down proportionally. A node can never distribute more
 *     than 100% of its own price.
 *  5. Whatever is left over is reported as idle (schedulable but unused) and
 *     system-reserved (capacity the kubelet keeps). Neither is spread across
 *     tenants: silently doing that overcharges them and hides the actual
 *     finding, which is that the cluster is oversized.
 */
export function allocateClusterCost(input: CostModelInput): ClusterAllocation {
  const currency = input.currency ?? "USD";
  const cpuCostShare = clampShare(input.cpuCostShare ?? DEFAULT_CPU_COST_SHARE);
  const memCostShare = 1 - cpuCostShare;

  const nodesByName = new Map(input.nodes.map((n) => [n.name, n]));
  const podsByNode = new Map<string, CostModelPod[]>();
  const unplacedPods: CostModelPod[] = [];
  for (const pod of input.pods) {
    const node = pod.nodeName ? nodesByName.get(pod.nodeName) : undefined;
    if (!node) {
      unplacedPods.push(pod);
      continue;
    }
    const list = podsByNode.get(pod.nodeName);
    if (list) list.push(pod);
    else podsByNode.set(pod.nodeName, [pod]);
  }

  const anyUsage =
    input.pods.some((p) => p.usage != null) || input.nodes.some((n) => n.usage != null);
  const basis: AllocationBasis = anyUsage ? "usage-or-requests" : "requests";

  const podAllocations: PodAllocation[] = [];
  const nodeAllocations: NodeAllocation[] = [];

  for (const node of input.nodes) {
    const pods = podsByNode.get(node.name) ?? [];
    const rate =
      typeof node.hourlyRate === "number" && node.hourlyRate >= 0 ? node.hourlyRate : null;
    const cpuPool = rate == null ? null : rate * cpuCostShare;
    const memPool = rate == null ? null : rate * memCostShare;

    // Rule 2: charge the greater of request and usage, per dimension.
    const charged = pods.map((pod) => ({
      pod,
      charged: {
        cpuCores: Math.max(pod.requests.cpuCores, pod.usage?.cpuCores ?? 0),
        memoryBytes: Math.max(pod.requests.memoryBytes, pod.usage?.memoryBytes ?? 0),
      },
    }));

    const rawTotal = charged.reduce((acc, c) => add(acc, c.charged), ZERO);

    // Rule 4: never distribute more than the node's own price.
    const cpuScale =
      node.capacity.cpuCores > 0 && rawTotal.cpuCores > node.capacity.cpuCores
        ? node.capacity.cpuCores / rawTotal.cpuCores
        : 1;
    const memScale =
      node.capacity.memoryBytes > 0 && rawTotal.memoryBytes > node.capacity.memoryBytes
        ? node.capacity.memoryBytes / rawTotal.memoryBytes
        : 1;

    let allocated: ResourcePair = ZERO;
    for (const entry of charged) {
      const scaled: ResourcePair = {
        cpuCores: entry.charged.cpuCores * cpuScale,
        memoryBytes: entry.charged.memoryBytes * memScale,
      };
      allocated = add(allocated, scaled);

      const cpuShare = node.capacity.cpuCores > 0 ? scaled.cpuCores / node.capacity.cpuCores : 0;
      const memoryShare =
        node.capacity.memoryBytes > 0 ? scaled.memoryBytes / node.capacity.memoryBytes : 0;
      const hourlyCost =
        cpuPool == null || memPool == null ? null : cpuPool * cpuShare + memPool * memoryShare;

      // Waste: what the pod is charged for, minus what it actually uses. Only
      // computable with live usage — with no metrics-server this stays null,
      // and a null waste is what makes the report say "unknown" instead of
      // asserting that a pod nobody measured is perfectly efficient.
      const usage = entry.pod.usage ?? null;
      const wasted: ResourcePair | null = usage
        ? {
            cpuCores: Math.max(0, entry.charged.cpuCores - usage.cpuCores),
            memoryBytes: Math.max(0, entry.charged.memoryBytes - usage.memoryBytes),
          }
        : null;
      // Priced through the same pools and the same overcommit scaling as the
      // cost above, so waste is always a strict subset of what was charged and
      // can never exceed it.
      const wastedHourlyCost =
        wasted == null || cpuPool == null || memPool == null
          ? null
          : cpuPool *
              (node.capacity.cpuCores > 0
                ? (wasted.cpuCores * cpuScale) / node.capacity.cpuCores
                : 0) +
            memPool *
              (node.capacity.memoryBytes > 0
                ? (wasted.memoryBytes * memScale) / node.capacity.memoryBytes
                : 0);

      podAllocations.push({
        name: entry.pod.name,
        namespace: entry.pod.namespace,
        nodeName: entry.pod.nodeName,
        workload: entry.pod.workload,
        workloadKind: entry.pod.workloadKind,
        requests: entry.pod.requests,
        limits: entry.pod.limits,
        usage,
        charged: entry.charged,
        cpuShare,
        memoryShare,
        hourlyCost,
        dailyCost: hourlyCost == null ? null : hourlyCost * HOURS_PER_DAY,
        efficiency: efficiencyOf(usage, entry.pod.requests),
        wasted,
        wastedHourlyCost,
        wastedDailyCost: scaleToDay(wastedHourlyCost),
        unplaced: false,
      });
    }

    // Rule 5: split the remainder into idle and system-reserved.
    const idle: ResourcePair = {
      cpuCores: Math.max(0, node.allocatable.cpuCores - allocated.cpuCores),
      memoryBytes: Math.max(0, node.allocatable.memoryBytes - allocated.memoryBytes),
    };
    const systemReserved: ResourcePair = {
      cpuCores: Math.max(0, node.capacity.cpuCores - allocated.cpuCores - idle.cpuCores),
      memoryBytes: Math.max(
        0,
        node.capacity.memoryBytes - allocated.memoryBytes - idle.memoryBytes,
      ),
    };

    const poolCost = (pair: ResourcePair): number | null => {
      if (cpuPool == null || memPool == null) return null;
      const cpu =
        node.capacity.cpuCores > 0 ? (pair.cpuCores / node.capacity.cpuCores) * cpuPool : 0;
      const mem =
        node.capacity.memoryBytes > 0
          ? (pair.memoryBytes / node.capacity.memoryBytes) * memPool
          : 0;
      return cpu + mem;
    };

    nodeAllocations.push({
      name: node.name,
      instanceType: node.instanceType ?? "",
      zone: node.zone ?? "",
      region: node.region ?? "",
      capacity: node.capacity,
      allocatable: node.allocatable,
      allocated,
      idle,
      systemReserved,
      hourlyRate: rate,
      hourlyAllocatedCost: poolCost(allocated),
      hourlyIdleCost: poolCost(idle),
      hourlySystemReservedCost: poolCost(systemReserved),
      podCount: pods.length,
      utilization: node.usage ?? null,
    });
  }

  // Pods whose node is gone: reported, never charged (rule: no machine, no money).
  for (const pod of unplacedPods) {
    const usage = pod.usage ?? null;
    podAllocations.push({
      name: pod.name,
      namespace: pod.namespace,
      nodeName: pod.nodeName,
      workload: pod.workload,
      workloadKind: pod.workloadKind,
      requests: pod.requests,
      limits: pod.limits,
      usage,
      charged: {
        cpuCores: Math.max(pod.requests.cpuCores, usage?.cpuCores ?? 0),
        memoryBytes: Math.max(pod.requests.memoryBytes, usage?.memoryBytes ?? 0),
      },
      cpuShare: 0,
      memoryShare: 0,
      hourlyCost: null,
      dailyCost: null,
      efficiency: efficiencyOf(usage, pod.requests),
      // An unplaced pod holds no machine, so it wastes no machine. The capacity
      // figure is still reportable; the money is not, same as its cost.
      wasted: usage
        ? {
            cpuCores: Math.max(0, pod.requests.cpuCores - usage.cpuCores),
            memoryBytes: Math.max(0, pod.requests.memoryBytes - usage.memoryBytes),
          }
        : null,
      wastedHourlyCost: null,
      wastedDailyCost: null,
      unplaced: true,
    });
  }

  const storage = allocateStorage(input.volumes ?? []);
  const loadBalancers = allocateLoadBalancers(input.loadBalancers ?? []);

  const workloads = rollUpWorkloads(podAllocations, storage.volumes, loadBalancers.loadBalancers);
  const namespaces = rollUpNamespaces(podAllocations, storage.volumes, loadBalancers.loadBalancers);

  const hourlyAllocatedCost = sumCosts(nodeAllocations.map((n) => n.hourlyAllocatedCost));
  const hourlyIdleCost = sumCosts(nodeAllocations.map((n) => n.hourlyIdleCost));
  const hourlySystemReservedCost = sumCosts(nodeAllocations.map((n) => n.hourlySystemReservedCost));
  const hourlyNodeCost = sumCosts(nodeAllocations.map((n) => n.hourlyRate));

  const controlPlaneRate = input.controlPlaneHourlyRate;
  const hourlyControlPlaneCost =
    typeof controlPlaneRate === "number" &&
    Number.isFinite(controlPlaneRate) &&
    controlPlaneRate >= 0
      ? controlPlaneRate
      : null;

  // The cluster's whole bill: machines, plus the three things that are billed
  // alongside them. Storage counts both the attributed and the unattached
  // buckets — unattached money is still money the cluster is spending.
  const hourlyTotalCost = sumCosts([
    hourlyNodeCost,
    hourlyControlPlaneCost,
    storage.hourlyAttributedCost,
    storage.hourlyUnattachedCost,
    loadBalancers.hourlyCost,
  ]);

  const clusterRequests = podAllocations.reduce((acc, p) => add(acc, p.requests), ZERO);
  const clusterUsage = anyUsage
    ? podAllocations.reduce((acc, p) => add(acc, p.usage ?? ZERO), ZERO)
    : null;
  const clusterWasted = anyUsage
    ? podAllocations.reduce((acc, p) => add(acc, p.wasted ?? ZERO), ZERO)
    : null;
  const wastedHourlyCost = sumCosts(podAllocations.map((p) => p.wastedHourlyCost));

  const unpricedNodes = nodeAllocations.filter((n) => n.hourlyRate == null).map((n) => n.name);

  return {
    currency,
    cpuCostShare,
    basis,
    fullyPriced: nodeAllocations.length > 0 && unpricedNodes.length === 0,
    pricedNodeCount: nodeAllocations.length - unpricedNodes.length,
    nodeCount: nodeAllocations.length,
    unpricedNodes,
    hourlyNodeCost,
    dailyNodeCost: scaleToDay(hourlyNodeCost),
    hourlyTotalCost,
    dailyTotalCost: scaleToDay(hourlyTotalCost),
    hourlyIdleCost,
    dailyIdleCost: scaleToDay(hourlyIdleCost),
    hourlySystemReservedCost,
    dailySystemReservedCost: scaleToDay(hourlySystemReservedCost),
    hourlyAllocatedCost,
    dailyAllocatedCost: scaleToDay(hourlyAllocatedCost),
    hourlyControlPlaneCost,
    dailyControlPlaneCost: scaleToDay(hourlyControlPlaneCost),
    wasted: clusterWasted,
    wastedHourlyCost,
    wastedDailyCost: scaleToDay(wastedHourlyCost),
    efficiency: efficiencyOf(clusterUsage, clusterRequests),
    storage,
    loadBalancers,
    nodes: nodeAllocations,
    pods: podAllocations,
    workloads,
    namespaces,
  };
}

/**
 * Price and classify every PersistentVolumeClaim.
 *
 * Three outcomes, and the classification is the point:
 *
 *  - **Attributed** — exactly one workload mounts it (charged to that
 *    workload), or several do (charged to the namespace, because splitting a
 *    shared ReadWriteMany disk N ways would be an invented apportionment).
 *  - **Unattached** — bound, therefore provisioned and billing, but no running
 *    pod mounts it. Its own bucket.
 *  - **Unbound** — `Pending` or `Lost`. Never priced.
 */
function allocateStorage(volumes: CostModelVolume[]): StorageTotals {
  const allocations: VolumeAllocation[] = [];
  const unpricedClasses = new Set<string>();

  for (const volume of volumes) {
    const unbound = volume.phase !== "Bound";
    const mounters = dedupeTargets(volume.mountedBy);
    const unattached = !unbound && mounters.length === 0;
    const shared = mounters.length > 1;
    const single = mounters.length === 1 ? mounters[0]! : null;

    const rate = volume.gibMonthRate;
    const hourlyCost =
      unbound || rate === undefined || !Number.isFinite(rate)
        ? null
        : (volume.gib * rate) / HOURS_PER_MONTH;
    if (!unbound && (rate === undefined || !Number.isFinite(rate))) {
      unpricedClasses.add(volume.storageClass || "(default class)");
    }

    allocations.push({
      name: volume.name,
      namespace: volume.namespace,
      storageClass: volume.storageClass,
      phase: volume.phase,
      gib: volume.gib,
      capacityBasis: volume.capacityBasis,
      workload: single?.workload ?? null,
      workloadKind: single?.workloadKind ?? null,
      shared,
      unattached,
      unbound,
      hourlyCost,
      dailyCost: scaleToDay(hourlyCost),
    });
  }

  allocations.sort(
    (a, b) =>
      (b.dailyCost ?? -1) - (a.dailyCost ?? -1) ||
      b.gib - a.gib ||
      `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`),
  );

  const bound = allocations.filter((v) => !v.unbound);
  const unattachedVolumes = bound.filter((v) => v.unattached);
  const attachedVolumes = bound.filter((v) => !v.unattached);
  const unboundVolumes = allocations.filter((v) => v.unbound);

  const hourlyAttributedCost = sumCosts(attachedVolumes.map((v) => v.hourlyCost));
  const hourlyUnattachedCost = sumCosts(unattachedVolumes.map((v) => v.hourlyCost));

  return {
    volumes: allocations,
    count: allocations.length,
    gib: bound.reduce((acc, v) => acc + v.gib, 0),
    unattachedCount: unattachedVolumes.length,
    unattachedGib: unattachedVolumes.reduce((acc, v) => acc + v.gib, 0),
    unboundCount: unboundVolumes.length,
    unboundGib: unboundVolumes.reduce((acc, v) => acc + v.gib, 0),
    hourlyAttributedCost,
    dailyAttributedCost: scaleToDay(hourlyAttributedCost),
    hourlyUnattachedCost,
    dailyUnattachedCost: scaleToDay(hourlyUnattachedCost),
    unpricedClasses: [...unpricedClasses].sort(),
  };
}

/**
 * Price every `LoadBalancer` Service.
 *
 * A Service with no address in `status.loadBalancer.ingress` has not been
 * provisioned — the cloud controller is still working, or cannot. It is
 * counted (so a stuck one is visible) but not charged, on the same principle
 * as an unbound PVC: nothing exists yet to be billed for.
 */
function allocateLoadBalancers(input: CostModelLoadBalancer[]): LoadBalancerTotals {
  const allocations: LoadBalancerAllocation[] = input.map((lb) => {
    const pending = !lb.address;
    const rate = lb.hourlyRate;
    const hourlyCost =
      pending || rate === undefined || !Number.isFinite(rate) || rate < 0 ? null : rate;
    return {
      name: lb.name,
      namespace: lb.namespace,
      address: lb.address,
      loadBalancerClass: lb.loadBalancerClass,
      workload: lb.target?.workload ?? null,
      workloadKind: lb.target?.workloadKind ?? null,
      pending,
      hourlyCost,
      dailyCost: scaleToDay(hourlyCost),
    };
  });

  allocations.sort(
    (a, b) =>
      (b.dailyCost ?? -1) - (a.dailyCost ?? -1) ||
      `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`),
  );

  const provisioned = allocations.filter((lb) => !lb.pending);
  const hourlyCost = sumCosts(provisioned.map((lb) => lb.hourlyCost));

  return {
    loadBalancers: allocations,
    count: allocations.length,
    provisionedCount: provisioned.length,
    hourlyCost,
    dailyCost: scaleToDay(hourlyCost),
    anyUnpriced: provisioned.some((lb) => lb.hourlyCost == null),
  };
}

/** Distinct workloads, so two pods of the same Deployment count once. */
function dedupeTargets(targets: AttributionTarget[]): AttributionTarget[] {
  const seen = new Map<string, AttributionTarget>();
  for (const target of targets) {
    seen.set(`${target.workloadKind}/${target.workload}`, target);
  }
  return [...seen.values()];
}

function scaleToDay(hourly: number | null): number | null {
  return hourly == null ? null : hourly * HOURS_PER_DAY;
}

function clampShare(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CPU_COST_SHARE;
  return Math.min(1, Math.max(0, value));
}

/**
 * Stable workload identity. Deliberately `namespace/kind/name` and nothing
 * else: re-running the same day must reproduce byte-identical keys or the
 * host's cost-row dedupe writes duplicates instead of replacing.
 */
export function workloadKey(namespace: string, kind: string, name: string): string {
  return `${namespace}/${kind}/${name}`;
}

/**
 * The mutable accumulator behind both roll-ups. The nullable-cost lists are
 * collected rather than summed as they go, because `sumCosts` has to be able to
 * tell "nothing was priced" (null) from "priced at zero" (0), and that
 * distinction is lost the moment you add into a running number.
 */
interface RollUp extends CostBreakdown {
  podCount: number;
  requests: ResourcePair;
  usage: ResourcePair | null;
  charged: ResourcePair;
  wasted: ResourcePair | null;
  computeHourly: Array<number | null>;
  wastedHourly: Array<number | null>;
  storageHourly: Array<number | null>;
  loadBalancerHourly: Array<number | null>;
}

function newRollUp(): RollUp {
  return {
    podCount: 0,
    requests: ZERO,
    usage: null,
    charged: ZERO,
    wasted: null,
    computeHourlyCost: null,
    computeDailyCost: null,
    storageHourlyCost: null,
    storageDailyCost: null,
    loadBalancerHourlyCost: null,
    loadBalancerDailyCost: null,
    storageGib: 0,
    loadBalancerCount: 0,
    computeHourly: [],
    wastedHourly: [],
    storageHourly: [],
    loadBalancerHourly: [],
  };
}

function addPod(entry: RollUp, pod: PodAllocation): void {
  entry.podCount += 1;
  entry.requests = add(entry.requests, pod.requests);
  entry.charged = add(entry.charged, pod.charged);
  if (pod.usage) entry.usage = add(entry.usage ?? ZERO, pod.usage);
  // Same null-preserving rule as usage: a workload whose pods were never
  // measured has unknown waste, and `null + something` must stay meaningful.
  if (pod.wasted) entry.wasted = add(entry.wasted ?? ZERO, pod.wasted);
  entry.computeHourly.push(pod.hourlyCost);
  entry.wastedHourly.push(pod.wastedHourlyCost);
}

function addVolume(entry: RollUp, volume: VolumeAllocation): void {
  entry.storageGib += volume.gib;
  entry.storageHourly.push(volume.hourlyCost);
}

function addLoadBalancer(entry: RollUp, lb: LoadBalancerAllocation): void {
  entry.loadBalancerCount += 1;
  entry.loadBalancerHourly.push(lb.hourlyCost);
}

/** Collapse the accumulator into the public breakdown + totals. */
function finishRollUp(entry: RollUp): CostBreakdown & {
  requests: ResourcePair;
  usage: ResourcePair | null;
  charged: ResourcePair;
  podCount: number;
  hourlyCost: number | null;
  dailyCost: number | null;
  efficiency: Efficiency;
  wasted: ResourcePair | null;
  wastedHourlyCost: number | null;
  wastedDailyCost: number | null;
  usageUnknown: boolean;
} {
  const computeHourlyCost = sumCosts(entry.computeHourly);
  const storageHourlyCost = sumCosts(entry.storageHourly);
  const loadBalancerHourlyCost = sumCosts(entry.loadBalancerHourly);
  const wastedHourlyCost = sumCosts(entry.wastedHourly);
  const hourlyCost = sumCosts([computeHourlyCost, storageHourlyCost, loadBalancerHourlyCost]);

  return {
    podCount: entry.podCount,
    requests: entry.requests,
    usage: entry.usage,
    charged: entry.charged,
    computeHourlyCost,
    computeDailyCost: scaleToDay(computeHourlyCost),
    storageHourlyCost,
    storageDailyCost: scaleToDay(storageHourlyCost),
    loadBalancerHourlyCost,
    loadBalancerDailyCost: scaleToDay(loadBalancerHourlyCost),
    storageGib: entry.storageGib,
    loadBalancerCount: entry.loadBalancerCount,
    hourlyCost,
    dailyCost: scaleToDay(hourlyCost),
    efficiency: efficiencyOf(entry.usage, entry.requests),
    wasted: entry.wasted,
    wastedHourlyCost,
    wastedDailyCost: scaleToDay(wastedHourlyCost),
    // A workload with pods but no usage on any of them is unmeasured. One with
    // no pods at all (a scaled-to-zero StatefulSet still holding disks) is not
    // "unknown efficiency" — it has nothing to be efficient about.
    usageUnknown: entry.podCount > 0 && entry.usage == null,
  };
}

/**
 * Roll pods up to workloads, then fold in the storage and load balancers that
 * resolved to exactly one workload.
 *
 * A volume or load balancer that resolved to several workloads (or none) is
 * deliberately absent here and present in the namespace roll-up instead — the
 * namespace is the tightest scope it can be attributed to honestly.
 *
 * A workload can appear with `podCount: 0`: a StatefulSet scaled to zero still
 * owns its `volumeClaimTemplates` PVCs. That is a row worth having, because a
 * workload that costs money while running nothing is exactly the finding.
 */
function rollUpWorkloads(
  pods: PodAllocation[],
  volumes: VolumeAllocation[],
  loadBalancers: LoadBalancerAllocation[],
): WorkloadAllocation[] {
  const map = new Map<string, RollUp & { key: string; namespace: string } & AttributionTarget>();
  const ensure = (namespace: string, kind: string, name: string) => {
    const key = workloadKey(namespace, kind, name);
    let entry = map.get(key);
    if (!entry) {
      entry = { ...newRollUp(), key, namespace, workload: name, workloadKind: kind };
      map.set(key, entry);
    }
    return entry;
  };

  for (const pod of pods) addPod(ensure(pod.namespace, pod.workloadKind, pod.workload), pod);

  for (const volume of volumes) {
    if (volume.unbound || volume.unattached || volume.shared) continue;
    if (!volume.workload || !volume.workloadKind) continue;
    addVolume(ensure(volume.namespace, volume.workloadKind, volume.workload), volume);
  }

  for (const lb of loadBalancers) {
    if (!lb.workload || !lb.workloadKind) continue;
    addLoadBalancer(ensure(lb.namespace, lb.workloadKind, lb.workload), lb);
  }

  return [...map.values()]
    .map(({ key, namespace, workload, workloadKind, ...rest }) => ({
      key,
      namespace,
      workload,
      workloadKind,
      ...finishRollUp(rest),
    }))
    .sort(byDailyCostThenName);
}

/**
 * Roll pods up to namespaces, then fold in every attributable volume and load
 * balancer — including the shared ones the workload roll-up had to skip.
 *
 * Unattached and unbound volumes are excluded on purpose: they are the cluster
 * equivalent of idle capacity, and adding them to their namespace would
 * overcharge a tenant for a disk nothing of theirs is mounting. They appear in
 * {@link StorageTotals} and in their own cost row instead, tagged with the
 * namespace so whoever has to delete them can still find them.
 */
function rollUpNamespaces(
  pods: PodAllocation[],
  volumes: VolumeAllocation[],
  loadBalancers: LoadBalancerAllocation[],
): NamespaceAllocation[] {
  const map = new Map<string, RollUp & { namespace: string }>();
  const ensure = (namespace: string) => {
    let entry = map.get(namespace);
    if (!entry) {
      entry = { ...newRollUp(), namespace };
      map.set(namespace, entry);
    }
    return entry;
  };

  for (const pod of pods) addPod(ensure(pod.namespace), pod);
  for (const volume of volumes) {
    if (volume.unbound || volume.unattached) continue;
    addVolume(ensure(volume.namespace), volume);
  }
  for (const lb of loadBalancers) addLoadBalancer(ensure(lb.namespace), lb);

  return [...map.values()]
    .map(({ namespace, ...rest }) => ({ namespace, ...finishRollUp(rest) }))
    .sort(
      (a, b) => (b.dailyCost ?? -1) - (a.dailyCost ?? -1) || a.namespace.localeCompare(b.namespace),
    );
}

function byDailyCostThenName(a: WorkloadAllocation, b: WorkloadAllocation): number {
  return (b.dailyCost ?? -1) - (a.dailyCost ?? -1) || a.key.localeCompare(b.key);
}

/**
 * A workload is "badly over-requested" when it reserves capacity it
 * demonstrably does not use. Only ever true when we have live utilization —
 * requests alone say nothing about waste.
 */
export function isOverRequested(efficiency: Efficiency, threshold = 0.2): boolean {
  const worst = [efficiency.cpu, efficiency.memory].filter((v): v is number => v != null);
  if (worst.length === 0) return false;
  return Math.max(...worst) < threshold;
}

/** `$1.80` / `$0.004` — short enough for a pill subtitle. */
export function formatMoney(amount: number, currency = "USD"): string {
  const symbol = currency === "USD" ? "$" : currency === "EUR" ? "€" : "";
  const suffix = symbol ? "" : ` ${currency}`;
  const abs = Math.abs(amount);
  const digits = abs >= 100 ? 0 : abs >= 1 ? 2 : abs >= 0.01 ? 3 : 4;
  return `${symbol}${amount.toFixed(digits)}${suffix}`;
}

/** `~$1.80/day`, or an empty string when there is no money to show. */
export function formatDailyCost(daily: number | null, currency = "USD"): string {
  if (daily == null) return "";
  return `~${formatMoney(daily, currency)}/day`;
}

/** `18% CPU` — the tighter of the two efficiency figures is the useful one. */
export function formatEfficiency(efficiency: Efficiency): string {
  const parts: string[] = [];
  if (efficiency.cpu != null) parts.push(`${Math.round(efficiency.cpu * 100)}% CPU`);
  if (efficiency.memory != null) parts.push(`${Math.round(efficiency.memory * 100)}% mem`);
  return parts.join(" · ");
}
