import type { DashboardStat, ResourceInstance } from "@infrawrench/plugin-base";

import type { K8sFetch } from "./shared.js";
import type { Efficiency } from "./cost-model.js";
import { formatDailyCost, isOverRequested } from "./cost-model.js";
import type { CostIndex } from "./cost-surface.js";
import { podEntry, tightestEfficiency, workloadEntry } from "./cost-surface.js";

/**
 * Efficiency reads as a stat only when there is live utilization behind it.
 * `variant` flags the ones worth acting on: a workload using under a fifth of
 * what it reserved is paying for capacity it never touches.
 */
function efficiencyStat(efficiency: Efficiency): DashboardStat[] {
  const text = tightestEfficiency(efficiency);
  if (!text) return [];
  return [
    {
      label: "Efficiency",
      value: text,
      variant: isOverRequested(efficiency)
        ? "status-degraded"
        : isOverRequested(efficiency, 0.5)
          ? "default"
          : "status-healthy",
    },
  ];
}

/** The derived cost stat, or nothing at all when there is no rate. */
function costStat(daily: number | null, currency: string): DashboardStat[] {
  const text = formatDailyCost(daily, currency);
  return text ? [{ label: "Cost", value: text }] : [];
}

/**
 * Compute the dashboard summary cards for a resource. Each kind has its own
 * shape — e.g. Deployments show replica ratios, Pods show phase, Services
 * show their type/IP.
 *
 * `costs` is optional and always additive: a cluster with no rate, or no
 * metrics-server, shows exactly the stats it showed before.
 */
export async function fetchDashboardStats(
  resource: ResourceInstance,
  k8sFetch: K8sFetch,
  costs?: CostIndex,
): Promise<DashboardStat[]> {
  const f = resource.fields;
  const currency = costs?.currency ?? "USD";
  const namespace = String(f["namespace"] ?? "");
  const name = String(f["name"] ?? resource.displayName);

  switch (resource.resourceTypeId) {
    case "k8s-cluster": {
      const clusterStats: DashboardStat[] = [];
      try {
        const ver = await k8sFetch<{ gitVersion: string }>("/version");
        clusterStats.push({ label: "Version", value: ver.gitVersion });
      } catch {
        /* version is optional context, not the point of the card */
      }
      if (costs) {
        clusterStats.push(...costStat(costs.cluster.dailyTotalCost, currency));
        // Idle gets its own stat, not a share of everyone else's. A cluster
        // where most of the money is idle is oversized, and that is the
        // finding — burying it inside per-namespace numbers hides it.
        const idle = costs.cluster.dailyIdleCost;
        const total = costs.cluster.dailyTotalCost;
        if (idle != null && total != null && total > 0) {
          const pct = Math.round((idle / total) * 100);
          clusterStats.push({
            label: "Idle",
            value: `${formatDailyCost(idle, currency)} (${pct}%)`,
            variant: pct >= 50 ? "status-degraded" : pct >= 25 ? "default" : "status-healthy",
          });
        }
        clusterStats.push(...efficiencyStat(costs.cluster.efficiency));
        clusterStats.push({ label: "Nodes", value: String(costs.cluster.nodeCount) });
      }
      return clusterStats;
    }
    case "k8s-deployment":
    case "k8s-statefulset": {
      const ready = Number(f["readyReplicas"] ?? 0);
      const desired = Number(f["replicas"] ?? 0);
      const variant = ready === desired ? "status-healthy" : "status-degraded";
      const kind = resource.resourceTypeId === "k8s-deployment" ? "Deployment" : "StatefulSet";
      const entry = workloadEntry(costs, namespace, kind, name);
      return [
        { label: "Replicas", value: `${ready}/${desired}`, variant },
        ...costStat(entry?.dailyCost ?? null, currency),
        ...(entry ? efficiencyStat(entry.efficiency) : []),
        { label: "Namespace", value: namespace },
      ];
    }
    case "k8s-daemonset": {
      const ready = Number(f["numberReady"] ?? 0);
      const desired = Number(f["desiredNumberScheduled"] ?? 0);
      const variant = ready === desired ? "status-healthy" : "status-degraded";
      const entry = workloadEntry(costs, namespace, "DaemonSet", name);
      return [
        { label: "Ready", value: `${ready}/${desired}`, variant },
        ...costStat(entry?.dailyCost ?? null, currency),
        ...(entry ? efficiencyStat(entry.efficiency) : []),
        { label: "Namespace", value: namespace },
      ];
    }
    case "k8s-pod": {
      const phase = String(f["phase"] ?? "Unknown");
      const variant =
        phase === "Running"
          ? "status-healthy"
          : phase === "Succeeded"
            ? "status-healthy"
            : phase === "Failed"
              ? "status-error"
              : "status-degraded";
      const entry = podEntry(costs, namespace, name);
      return [
        { label: "Phase", value: phase, variant },
        ...(f["restartCount"] != null
          ? [{ label: "Restarts", value: String(f["restartCount"]) }]
          : []),
        ...costStat(entry?.dailyCost ?? null, currency),
        ...(entry ? efficiencyStat(entry.efficiency) : []),
        { label: "Namespace", value: namespace },
      ];
    }
    case "k8s-service":
      return [
        { label: "Type", value: String(f["type"] ?? "ClusterIP") },
        { label: "Cluster IP", value: String(f["clusterIP"] ?? "") },
        { label: "Namespace", value: String(f["namespace"] ?? "") },
      ];
    case "k8s-job": {
      const succeeded = Number(f["succeeded"] ?? 0);
      const active = Number(f["active"] ?? 0);
      return [
        { label: "Succeeded", value: String(succeeded) },
        { label: "Active", value: String(active) },
        { label: "Namespace", value: String(f["namespace"] ?? "") },
      ];
    }
    case "k8s-ingress":
      return [{ label: "Namespace", value: String(f["namespace"] ?? "") }];
    case "k8s-namespace": {
      const entry = costs?.namespaces.get(name);
      return [
        { label: "Name", value: name },
        ...(entry ? [{ label: "Pods", value: String(entry.podCount) }] : []),
        ...costStat(entry?.dailyCost ?? null, currency),
        ...(entry ? efficiencyStat(entry.efficiency) : []),
      ];
    }
    case "k8s-cronjob":
      return [
        { label: "Schedule", value: String(f["schedule"] ?? "") },
        ...(f["suspended"] === "true"
          ? [{ label: "Suspended", value: "Yes", variant: "status-degraded" as const }]
          : []),
        { label: "Namespace", value: String(f["namespace"] ?? "") },
      ];
    case "k8s-secret":
      return [
        { label: "Type", value: String(f["type"] ?? "Opaque") },
        { label: "Entries", value: String(f["dataCount"] ?? 0) },
        { label: "Namespace", value: String(f["namespace"] ?? "") },
      ];
    case "k8s-configmap":
      return [
        { label: "Entries", value: String(f["dataCount"] ?? 0) },
        { label: "Namespace", value: String(f["namespace"] ?? "") },
      ];
    default:
      return [];
  }
}
