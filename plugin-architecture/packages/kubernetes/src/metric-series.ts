/**
 * Cost and efficiency as time series.
 *
 * The cluster has no historical store of its own — the allocation is a
 * snapshot of what is running right now. So a "series" here is that snapshot
 * projected flat across the requested window: two points, same value, start
 * and end. That is honest (the run-rate really is constant as far as we know)
 * and it renders as a readable line rather than a single floating dot.
 *
 * The historical version of these numbers is the cost rows this plugin writes
 * every day via `fetchCostData` — those accumulate into real history and are
 * what the org-level cost views chart. This series exists so the numbers also
 * appear on the resource's own Metrics tab, and — via the peer integration's
 * `exposeMetricsToParent` flag — on the *cloud cluster's* Metrics tab, next to
 * the provider's own node CPU and memory series. That is the payoff of routing
 * this through the peer rather than bolting it onto each cloud plugin.
 */

import type { MetricSeries } from "@infrawrench/plugin-base";

import type { ClusterAllocation, Efficiency } from "./cost-model.js";
import type { CostIndex } from "./cost-surface.js";
import { podEntry, workloadEntry } from "./cost-surface.js";

/** Flatten one value across the window. Empty when the value is unknown. */
function flatSeries(
  label: string,
  value: number | null,
  unit: string,
  range: { startMs: number; endMs: number },
): MetricSeries[] {
  if (value == null || !Number.isFinite(value)) return [];
  return [
    {
      label,
      unit,
      points: [
        { timestamp: range.startMs, value },
        { timestamp: range.endMs, value },
      ],
    },
  ];
}

function efficiencySeries(
  efficiency: Efficiency,
  range: { startMs: number; endMs: number },
): MetricSeries[] {
  return [
    ...flatSeries(
      "CPU efficiency",
      efficiency.cpu == null ? null : efficiency.cpu * 100,
      "%",
      range,
    ),
    ...flatSeries(
      "Memory efficiency",
      efficiency.memory == null ? null : efficiency.memory * 100,
      "%",
      range,
    ),
  ];
}

function clusterSeries(
  cluster: ClusterAllocation,
  currency: string,
  range: { startMs: number; endMs: number },
): MetricSeries[] {
  const money = `${currency}/day`;
  return [
    ...flatSeries("Cluster cost", cluster.dailyTotalCost, money, range),
    ...flatSeries("Node compute", cluster.dailyNodeCost, money, range),
    ...flatSeries("Allocated to workloads", cluster.dailyAllocatedCost, money, range),
    // Idle is charted as its own line for the same reason it is its own table
    // row: it is the difference between what the cluster costs and what the
    // workloads asked for, and that gap is the finding. The control plane and
    // the unattached volumes are lines for the same reason — each is money the
    // cluster spends that no workload can be pointed at.
    ...flatSeries("Idle capacity", cluster.dailyIdleCost, money, range),
    ...flatSeries("System reserved", cluster.dailySystemReservedCost, money, range),
    ...flatSeries("Control plane", cluster.dailyControlPlaneCost, money, range),
    ...flatSeries("Persistent volumes", cluster.storage.dailyAttributedCost, money, range),
    ...flatSeries("Unattached volumes", cluster.storage.dailyUnattachedCost, money, range),
    ...flatSeries("Load balancers", cluster.loadBalancers.dailyCost, money, range),
    // The money twin of the efficiency percentages below: what the gap between
    // requested and used actually costs.
    ...flatSeries("Over-requested (wasted)", cluster.wastedDailyCost, money, range),
    ...efficiencySeries(cluster.efficiency, range),
  ];
}

/**
 * Build the series for one resource. Returns `[]` for kinds that have no cost
 * dimension, and for every kind when there is no cost data at all — an empty
 * Metrics tab is better than one full of zeroes.
 */
export function buildCostMetricSeries(
  resourceTypeId: string,
  fields: Record<string, unknown>,
  displayName: string,
  costs: CostIndex,
  timeRange?: { startMs: number; endMs: number },
): MetricSeries[] {
  const endMs = timeRange?.endMs ?? Date.now();
  const startMs = timeRange?.startMs ?? endMs - 24 * 60 * 60 * 1000;
  const range = { startMs, endMs };
  const currency = costs.currency;
  const money = `${currency}/day`;
  const namespace = String(fields["namespace"] ?? "default");
  const name = String(fields["name"] ?? displayName);

  switch (resourceTypeId) {
    case "k8s-cluster":
      return clusterSeries(costs.cluster, currency, range);
    case "k8s-namespace": {
      const entry = costs.namespaces.get(String(fields["name"] ?? displayName));
      if (!entry) return [];
      return [
        ...flatSeries("Namespace cost", entry.dailyCost, money, range),
        ...flatSeries("Compute", entry.computeDailyCost, money, range),
        ...flatSeries("Persistent volumes", entry.storageDailyCost, money, range),
        ...flatSeries("Load balancers", entry.loadBalancerDailyCost, money, range),
        ...flatSeries("Over-requested (wasted)", entry.wastedDailyCost, money, range),
        ...efficiencySeries(entry.efficiency, range),
      ];
    }
    case "k8s-pod": {
      const entry = podEntry(costs, namespace, name);
      if (!entry) return [];
      return [
        ...flatSeries("Pod cost", entry.dailyCost, money, range),
        ...efficiencySeries(entry.efficiency, range),
      ];
    }
    case "k8s-deployment":
    case "k8s-statefulset":
    case "k8s-daemonset": {
      const kind =
        resourceTypeId === "k8s-deployment"
          ? "Deployment"
          : resourceTypeId === "k8s-statefulset"
            ? "StatefulSet"
            : "DaemonSet";
      const entry = workloadEntry(costs, namespace, kind, name);
      if (!entry) return [];
      return [
        ...flatSeries(`${kind} cost`, entry.dailyCost, money, range),
        ...flatSeries("Persistent volumes", entry.storageDailyCost, money, range),
        ...flatSeries("Load balancers", entry.loadBalancerDailyCost, money, range),
        ...flatSeries("Over-requested (wasted)", entry.wastedDailyCost, money, range),
        ...efficiencySeries(entry.efficiency, range),
      ];
    }
    default:
      return [];
  }
}

/**
 * The series a *cloud* cluster resource sees on its own Metrics tab, merged in
 * by the host because the peer integration sets `exposeMetricsToParent`. The
 * parent is the whole cluster, so it gets the cluster-level series.
 */
export function buildParentClusterMetricSeries(
  costs: CostIndex,
  timeRange?: { startMs: number; endMs: number },
): MetricSeries[] {
  const endMs = timeRange?.endMs ?? Date.now();
  const startMs = timeRange?.startMs ?? endMs - 24 * 60 * 60 * 1000;
  return clusterSeries(costs.cluster, costs.currency, { startMs, endMs });
}
