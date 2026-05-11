import type { DashboardStat, ResourceInstance } from "@infrawrench/plugin-base";

import type { K8sFetch } from "./shared.js";

/**
 * Compute the dashboard summary cards for a resource. Each kind has its own
 * shape — e.g. Deployments show replica ratios, Pods show phase, Services
 * show their type/IP.
 */
export async function fetchDashboardStats(
  resource: ResourceInstance,
  k8sFetch: K8sFetch,
): Promise<DashboardStat[]> {
  const f = resource.fields;

  switch (resource.resourceTypeId) {
    case "k8s-cluster": {
      try {
        const ver = await k8sFetch<{ gitVersion: string }>("/version");
        return [{ label: "Version", value: ver.gitVersion }];
      } catch {
        return [];
      }
    }
    case "k8s-deployment":
    case "k8s-statefulset": {
      const ready = Number(f["readyReplicas"] ?? 0);
      const desired = Number(f["replicas"] ?? 0);
      const variant = ready === desired ? "status-healthy" : "status-degraded";
      return [
        { label: "Replicas", value: `${ready}/${desired}`, variant },
        { label: "Namespace", value: String(f["namespace"] ?? "") },
      ];
    }
    case "k8s-daemonset": {
      const ready = Number(f["numberReady"] ?? 0);
      const desired = Number(f["desiredNumberScheduled"] ?? 0);
      const variant = ready === desired ? "status-healthy" : "status-degraded";
      return [
        { label: "Ready", value: `${ready}/${desired}`, variant },
        { label: "Namespace", value: String(f["namespace"] ?? "") },
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
      return [
        { label: "Phase", value: phase, variant },
        ...(f["restartCount"] != null
          ? [{ label: "Restarts", value: String(f["restartCount"]) }]
          : []),
        { label: "Namespace", value: String(f["namespace"] ?? "") },
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
    case "k8s-namespace":
      return [{ label: "Name", value: String(f["name"] ?? "") }];
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
