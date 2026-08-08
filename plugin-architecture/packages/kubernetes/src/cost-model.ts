/**
 * Kubernetes cost allocation.
 *
 * A cluster has no billing API. Its spend lands on the *cloud* account that
 * owns the nodes, as a line item for a pile of VMs. Everything in this module
 * is therefore **derived**: node capacity, times what that node costs, times
 * each pod's share of it. Nothing here is a billed amount, and the outputs
 * carry that distinction (`basis`, `pricedNodeCount`) so callers can label it.
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

export interface CostModelInput {
  nodes: CostModelNode[];
  pods: CostModelPod[];
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
   * True when the pod names no node, or names a node that is not in the input
   * (drained, deleted, or listed between two API calls). Such a pod is still
   * reported — with its requests — but carries no cost, because there is no
   * machine to take the money from.
   */
  unplaced: boolean;
}

export interface WorkloadAllocation {
  /** Stable identity: `namespace/kind/name`. Used as the cost-row key. */
  key: string;
  namespace: string;
  workload: string;
  workloadKind: string;
  podCount: number;
  requests: ResourcePair;
  usage: ResourcePair | null;
  charged: ResourcePair;
  hourlyCost: number | null;
  dailyCost: number | null;
  efficiency: Efficiency;
}

export interface NamespaceAllocation {
  namespace: string;
  podCount: number;
  requests: ResourcePair;
  usage: ResourcePair | null;
  charged: ResourcePair;
  hourlyCost: number | null;
  dailyCost: number | null;
  efficiency: Efficiency;
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
  hourlyTotalCost: number | null;
  dailyTotalCost: number | null;
  /** Schedulable-but-unused capacity. Its own line, never spread over tenants. */
  hourlyIdleCost: number | null;
  dailyIdleCost: number | null;
  hourlySystemReservedCost: number | null;
  dailySystemReservedCost: number | null;
  hourlyAllocatedCost: number | null;
  dailyAllocatedCost: number | null;
  efficiency: Efficiency;
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

      podAllocations.push({
        name: entry.pod.name,
        namespace: entry.pod.namespace,
        nodeName: entry.pod.nodeName,
        workload: entry.pod.workload,
        workloadKind: entry.pod.workloadKind,
        requests: entry.pod.requests,
        limits: entry.pod.limits,
        usage: entry.pod.usage ?? null,
        charged: entry.charged,
        cpuShare,
        memoryShare,
        hourlyCost,
        dailyCost: hourlyCost == null ? null : hourlyCost * HOURS_PER_DAY,
        efficiency: efficiencyOf(entry.pod.usage ?? null, entry.pod.requests),
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
    podAllocations.push({
      name: pod.name,
      namespace: pod.namespace,
      nodeName: pod.nodeName,
      workload: pod.workload,
      workloadKind: pod.workloadKind,
      requests: pod.requests,
      limits: pod.limits,
      usage: pod.usage ?? null,
      charged: {
        cpuCores: Math.max(pod.requests.cpuCores, pod.usage?.cpuCores ?? 0),
        memoryBytes: Math.max(pod.requests.memoryBytes, pod.usage?.memoryBytes ?? 0),
      },
      cpuShare: 0,
      memoryShare: 0,
      hourlyCost: null,
      dailyCost: null,
      efficiency: efficiencyOf(pod.usage ?? null, pod.requests),
      unplaced: true,
    });
  }

  const workloads = rollUpWorkloads(podAllocations);
  const namespaces = rollUpNamespaces(podAllocations);

  const hourlyAllocatedCost = sumCosts(nodeAllocations.map((n) => n.hourlyAllocatedCost));
  const hourlyIdleCost = sumCosts(nodeAllocations.map((n) => n.hourlyIdleCost));
  const hourlySystemReservedCost = sumCosts(nodeAllocations.map((n) => n.hourlySystemReservedCost));
  const hourlyTotalCost = sumCosts(nodeAllocations.map((n) => n.hourlyRate));

  const clusterRequests = podAllocations.reduce((acc, p) => add(acc, p.requests), ZERO);
  const clusterUsage = anyUsage
    ? podAllocations.reduce((acc, p) => add(acc, p.usage ?? ZERO), ZERO)
    : null;

  const unpricedNodes = nodeAllocations.filter((n) => n.hourlyRate == null).map((n) => n.name);

  return {
    currency,
    cpuCostShare,
    basis,
    fullyPriced: nodeAllocations.length > 0 && unpricedNodes.length === 0,
    pricedNodeCount: nodeAllocations.length - unpricedNodes.length,
    nodeCount: nodeAllocations.length,
    unpricedNodes,
    hourlyTotalCost,
    dailyTotalCost: scaleToDay(hourlyTotalCost),
    hourlyIdleCost,
    dailyIdleCost: scaleToDay(hourlyIdleCost),
    hourlySystemReservedCost,
    dailySystemReservedCost: scaleToDay(hourlySystemReservedCost),
    hourlyAllocatedCost,
    dailyAllocatedCost: scaleToDay(hourlyAllocatedCost),
    efficiency: efficiencyOf(clusterUsage, clusterRequests),
    nodes: nodeAllocations,
    pods: podAllocations,
    workloads,
    namespaces,
  };
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

function rollUpWorkloads(pods: PodAllocation[]): WorkloadAllocation[] {
  const map = new Map<string, WorkloadAllocation & { hourly: Array<number | null> }>();
  for (const pod of pods) {
    const key = workloadKey(pod.namespace, pod.workloadKind, pod.workload);
    let entry = map.get(key);
    if (!entry) {
      entry = {
        key,
        namespace: pod.namespace,
        workload: pod.workload,
        workloadKind: pod.workloadKind,
        podCount: 0,
        requests: ZERO,
        usage: null,
        charged: ZERO,
        hourlyCost: null,
        dailyCost: null,
        efficiency: { cpu: null, memory: null },
        hourly: [],
      };
      map.set(key, entry);
    }
    entry.podCount += 1;
    entry.requests = add(entry.requests, pod.requests);
    entry.charged = add(entry.charged, pod.charged);
    if (pod.usage) entry.usage = add(entry.usage ?? ZERO, pod.usage);
    entry.hourly.push(pod.hourlyCost);
  }

  return [...map.values()]
    .map(({ hourly, ...rest }) => {
      const hourlyCost = sumCosts(hourly);
      return {
        ...rest,
        hourlyCost,
        dailyCost: scaleToDay(hourlyCost),
        efficiency: efficiencyOf(rest.usage, rest.requests),
      };
    })
    .sort(byDailyCostThenName);
}

function rollUpNamespaces(pods: PodAllocation[]): NamespaceAllocation[] {
  const map = new Map<string, NamespaceAllocation & { hourly: Array<number | null> }>();
  for (const pod of pods) {
    let entry = map.get(pod.namespace);
    if (!entry) {
      entry = {
        namespace: pod.namespace,
        podCount: 0,
        requests: ZERO,
        usage: null,
        charged: ZERO,
        hourlyCost: null,
        dailyCost: null,
        efficiency: { cpu: null, memory: null },
        hourly: [],
      };
      map.set(pod.namespace, entry);
    }
    entry.podCount += 1;
    entry.requests = add(entry.requests, pod.requests);
    entry.charged = add(entry.charged, pod.charged);
    if (pod.usage) entry.usage = add(entry.usage ?? ZERO, pod.usage);
    entry.hourly.push(pod.hourlyCost);
  }

  return [...map.values()]
    .map(({ hourly, ...rest }) => {
      const hourlyCost = sumCosts(hourly);
      return {
        ...rest,
        hourlyCost,
        dailyCost: scaleToDay(hourlyCost),
        efficiency: efficiencyOf(rest.usage, rest.requests),
      };
    })
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
