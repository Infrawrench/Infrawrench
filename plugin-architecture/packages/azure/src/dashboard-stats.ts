/**
 * Per-resource-type dashboard stat builders.
 *
 * Maps a `ResourceInstance` to the small `DashboardStat[]` shown on the
 * resource overview cards. Most types fall through to a generic field-sniffing
 * fallback.
 */
import type { DashboardStat, ResourceInstance } from "@infrawrench/plugin-base";

export function buildAzureDashboardStats(resource: ResourceInstance): DashboardStat[] {
  const f = resource.fields;
  const ro = resource.resolvedOutputs ?? {};

  switch (resource.resourceTypeId) {
    case "azure-vm": {
      const state = String(f.state ?? "unknown");
      const stats: DashboardStat[] = [
        {
          label: "State",
          value: state,
          variant:
            state === "Running"
              ? "status-healthy"
              : state === "Deallocated" || state === "Stopped"
                ? "status-error"
                : "status-degraded",
        },
        { label: "Location", value: String(f.location ?? "") },
      ];
      if (ro.publicIp) stats.push({ label: "Public IP", value: String(ro.publicIp) });
      return stats;
    }
    case "azure-aks-cluster": {
      return [
        { label: "Version", value: String(f.version ?? "") },
        { label: "Location", value: String(f.location ?? "") },
        { label: "Nodes", value: String(f.nodeCount ?? 0) },
      ];
    }
    case "azure-sql-server":
    case "azure-sql-database":
    case "azure-cosmos-account": {
      const stateVal = String(f.state ?? f.status ?? "unknown");
      return [
        {
          label: "State",
          value: stateVal,
          variant:
            stateVal === "Ready" || stateVal === "Online" || stateVal === "Running"
              ? "status-healthy"
              : "status-degraded",
        },
        { label: "Location", value: String(f.location ?? "") },
      ];
    }
    default: {
      // Generic fallback — show key fields from the resource
      const stats: DashboardStat[] = [];
      const statusVal = f.status ?? f.state ?? f.provisioningState ?? f.phase;
      if (statusVal != null) {
        const s = String(statusVal).toLowerCase();
        stats.push({
          label: "Status",
          value: String(statusVal),
          variant: [
            "running",
            "active",
            "available",
            "ready",
            "enabled",
            "healthy",
            "succeeded",
            "online",
          ].some((v) => s.includes(v))
            ? "status-healthy"
            : ["error", "failed", "terminated", "deleted", "unhealthy"].some((v) => s.includes(v))
              ? "status-error"
              : ["pending", "creating", "updating", "stopping", "degraded", "warning"].some((v) =>
                    s.includes(v),
                  )
                ? "status-degraded"
                : "default",
        });
      }
      const typeVal =
        f.type ??
        f.kind ??
        f.engine ??
        f.instanceType ??
        f.tier ??
        f.machineType ??
        f.size ??
        f.sku;
      if (typeVal != null) stats.push({ label: "Type", value: String(typeVal) });
      const regionVal = f.region ?? f.location ?? f.zone;
      if (regionVal != null) stats.push({ label: "Region", value: String(regionVal) });
      return stats;
    }
  }
}
