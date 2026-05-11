import type { DashboardStat, MetricSeries, ResourceInstance } from "@infrawrench/plugin-base";
import type { AwsCredentials } from "./auth.js";
import { jsonCall } from "./client-transport.js";

export function fetchDashboardStats(
  resource: ResourceInstance,
  resourceTypeId: string,
): DashboardStat[] {
  const f = resource.fields;
  const ro = resource.resolvedOutputs ?? {};

  switch (resourceTypeId) {
    case "ec2-instance": {
      const state = String(f.state ?? "unknown");
      const stats: DashboardStat[] = [
        {
          label: "State",
          value: state,
          variant:
            state === "running"
              ? "status-healthy"
              : state === "stopped" || state === "terminated"
                ? "status-error"
                : "status-degraded",
        },
        { label: "Instance Type", value: String(f.instanceType ?? "") },
        { label: "AZ", value: String(f.availabilityZone ?? "") },
      ];
      if (ro.publicIp) stats.push({ label: "Public IP", value: String(ro.publicIp) });
      return stats;
    }
    case "rds-instance": {
      const status = String(f.status ?? "unknown");
      return [
        {
          label: "Status",
          value: status,
          variant:
            status === "available"
              ? "status-healthy"
              : status === "stopped"
                ? "status-error"
                : "status-degraded",
        },
        { label: "Engine", value: `${f.engine ?? ""} ${f.engineVersion ?? ""}`.trim() },
        { label: "Instance Class", value: String(f.instanceClass ?? "") },
        { label: "Storage", value: `${f.allocatedStorage ?? 0} GB` },
      ];
    }
    case "lambda-function": {
      return [
        { label: "Runtime", value: String(f.runtime ?? "") },
        { label: "Memory", value: `${f.memorySize ?? 0} MB` },
        { label: "Timeout", value: `${f.timeout ?? 0}s` },
      ];
    }
    case "s3-bucket": {
      return [{ label: "Region", value: String(f.region ?? "") }];
    }
    case "eks-cluster": {
      const status = String(f.status ?? "unknown");
      return [
        { label: "Version", value: String(f.version ?? "") },
        {
          label: "Status",
          value: status,
          variant:
            status === "ACTIVE" || status === "active" ? "status-healthy" : "status-degraded",
        },
        { label: "Region", value: String(f.region ?? "") },
      ];
    }
    default: {
      // Generic fallback — show key fields from the resource
      const stats: DashboardStat[] = [];
      const statusVal = f.status ?? f.state ?? f.phase;
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
        f.flavor;
      if (typeVal != null) stats.push({ label: "Type", value: String(typeVal) });
      const regionVal = f.region ?? f.location ?? f.zone ?? f.availabilityZone;
      if (regionVal != null) stats.push({ label: "Region", value: String(regionVal) });
      return stats;
    }
  }
}

export async function fetchMetricSeries(
  creds: AwsCredentials,
  resource: ResourceInstance,
  resourceTypeId: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const now = Date.now();
  const start = timeRange?.startMs ?? now - 3600_000;
  const end = timeRange?.endMs ?? now;
  const period = Math.max(60, Math.floor((end - start) / 60));

  const fetchCw = async (
    namespace: string,
    metricName: string,
    dimensions: Array<{ Name: string; Value: string }>,
    stat = "Average",
  ): Promise<MetricSeries> => {
    const data = await jsonCall<Record<string, unknown>>(
      creds,
      "monitoring",
      "GraniteServiceVersion20100801.GetMetricStatistics",
      {
        Namespace: namespace,
        MetricName: metricName,
        Dimensions: dimensions,
        StartTime: new Date(start).toISOString(),
        EndTime: new Date(end).toISOString(),
        Period: period,
        Statistics: [stat],
      },
    );
    const datapoints = (data["Datapoints"] as Array<Record<string, unknown>>) ?? [];
    return {
      label: metricName,
      unit: String(data["Label"] ?? ""),
      points: datapoints
        .map((dp) => ({
          timestamp: new Date(String(dp["Timestamp"])).getTime(),
          value: Number(dp[stat] ?? 0),
        }))
        .sort((a, b) => a.timestamp - b.timestamp),
    };
  };

  switch (resourceTypeId) {
    case "ec2-instance": {
      const instanceId = resource.externalId ?? "";
      const dims = [{ Name: "InstanceId", Value: instanceId }];
      const [cpu, netIn, netOut] = await Promise.all([
        fetchCw("AWS/EC2", "CPUUtilization", dims).catch(() => null),
        fetchCw("AWS/EC2", "NetworkIn", dims).catch(() => null),
        fetchCw("AWS/EC2", "NetworkOut", dims).catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (cpu && cpu.points.length > 0) results.push({ ...cpu, unit: "%" });
      if (netIn && netIn.points.length > 0)
        results.push({ ...netIn, label: "Network In", unit: " bytes" });
      if (netOut && netOut.points.length > 0)
        results.push({ ...netOut, label: "Network Out", unit: " bytes" });
      return results;
    }
    case "rds-instance": {
      const dbId = resource.externalId ?? "";
      const dims = [{ Name: "DBInstanceIdentifier", Value: dbId }];
      const [cpu, conns, freeStorage] = await Promise.all([
        fetchCw("AWS/RDS", "CPUUtilization", dims).catch(() => null),
        fetchCw("AWS/RDS", "DatabaseConnections", dims, "Sum").catch(() => null),
        fetchCw("AWS/RDS", "FreeStorageSpace", dims).catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (cpu && cpu.points.length > 0) results.push({ ...cpu, unit: "%" });
      if (conns && conns.points.length > 0) results.push({ ...conns, label: "Connections" });
      if (freeStorage && freeStorage.points.length > 0)
        results.push({ ...freeStorage, label: "Free Storage", unit: " bytes" });
      return results;
    }
    case "lambda-function": {
      const fnName = resource.externalId ?? "";
      const dims = [{ Name: "FunctionName", Value: fnName }];
      const [invocations, duration, errors] = await Promise.all([
        fetchCw("AWS/Lambda", "Invocations", dims, "Sum").catch(() => null),
        fetchCw("AWS/Lambda", "Duration", dims).catch(() => null),
        fetchCw("AWS/Lambda", "Errors", dims, "Sum").catch(() => null),
      ]);
      const results: MetricSeries[] = [];
      if (invocations && invocations.points.length > 0)
        results.push({ ...invocations, label: "Invocations" });
      if (duration && duration.points.length > 0)
        results.push({ ...duration, label: "Duration", unit: "ms" });
      if (errors && errors.points.length > 0) results.push({ ...errors, label: "Errors" });
      return results;
    }
    default:
      return [];
  }
}
