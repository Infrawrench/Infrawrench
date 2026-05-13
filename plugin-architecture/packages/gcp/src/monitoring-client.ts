import type {
  DashboardStat,
  MetricSeries,
  LogsFetchParams,
  LogsFetchResult,
} from "@infrawrench/plugin-base";
import type { GcpClientContext } from "./shared.js";

export async function fetchDashboardStats(
  ctx: GcpClientContext,
  resourceTypeId: string,
  resourceId: string,
  accountId: string,
): Promise<DashboardStat[]> {
  const resource = await ctx.getResource(resourceTypeId, resourceId, accountId);
  const f = resource.fields;
  const ro = resource.resolvedOutputs ?? {};

  switch (resourceTypeId) {
    case "gce-instance": {
      const status = String(f["status"] ?? "unknown");
      const stats: DashboardStat[] = [
        {
          label: "Status",
          value: status,
          variant:
            status === "RUNNING"
              ? "status-healthy"
              : status === "TERMINATED"
                ? "status-error"
                : "status-degraded",
        },
        { label: "Machine Type", value: String(f["machineType"] ?? "") },
        { label: "Zone", value: String(f["zone"] ?? "") },
      ];
      if (ro["publicIp"]) stats.push({ label: "Public IP", value: String(ro["publicIp"]) });
      return stats;
    }
    case "cloud-sql-instance": {
      const state = String(f["state"] ?? "unknown");
      return [
        {
          label: "State",
          value: state,
          variant:
            state === "RUNNABLE"
              ? "status-healthy"
              : state === "STOPPED"
                ? "status-error"
                : "status-degraded",
        },
        { label: "Engine", value: String(f["databaseVersion"] ?? "") },
        { label: "Tier", value: String(f["tier"] ?? "") },
        { label: "Region", value: String(f["region"] ?? "") },
      ];
    }
    case "cloud-run-service": {
      const stats: DashboardStat[] = [{ label: "Region", value: String(f["region"] ?? "") }];
      if (f["url"]) stats.push({ label: "URL", value: String(f["url"]) });
      return stats;
    }
    case "gke-cluster": {
      const status = String(f["status"] ?? "unknown");
      return [
        {
          label: "Status",
          value: status,
          variant: status === "RUNNING" ? "status-healthy" : "status-degraded",
        },
        { label: "Location", value: String(f["location"] ?? "") },
        { label: "Nodes", value: String(f["nodeCount"] ?? 0) },
      ];
    }
    case "backend-service": {
      return [
        { label: "Protocol", value: String(f["protocol"] ?? "—") },
        { label: "Scheme", value: String(f["loadBalancingScheme"] ?? "—") },
        { label: "Backends", value: String(f["backendCount"] ?? 0) },
        { label: "Health checks", value: String(f["healthCheckCount"] ?? 0) },
      ];
    }
    default: {
      // Generic fallback — show key fields from the resource
      const stats: DashboardStat[] = [];
      const statusVal = f["status"] ?? f["state"] ?? f["phase"];
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
            "runnable",
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
        f["type"] ??
        f["kind"] ??
        f["engine"] ??
        f["instanceType"] ??
        f["tier"] ??
        f["machineType"] ??
        f["size"] ??
        f["databaseVersion"];
      if (typeVal != null) stats.push({ label: "Type", value: String(typeVal) });
      const regionVal = f["region"] ?? f["location"] ?? f["zone"];
      if (regionVal != null) stats.push({ label: "Region", value: String(regionVal) });
      return stats;
    }
  }
}

export async function fetchMetricSeries(
  ctx: GcpClientContext,
  resourceTypeId: string,
  resourceId: string,
  accountId: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const now = Date.now();
  const startTime = new Date(timeRange?.startMs ?? now - 3_600_000).toISOString();
  const endTime = new Date(timeRange?.endMs ?? now).toISOString();

  interface GcpTimeSeriesPoint {
    interval: { startTime: string; endTime: string };
    value: { doubleValue?: number; int64Value?: string };
  }
  interface GcpTimeSeries {
    points: GcpTimeSeriesPoint[];
  }
  interface GcpTimeSeriesResponse {
    timeSeries?: GcpTimeSeries[];
  }

  const fetchSeries = async (
    metricType: string,
    resourceLabel: string,
    resourceValue: string,
    label: string,
    unit: string,
  ): Promise<MetricSeries | null> => {
    try {
      const baseUrl = `https://monitoring.googleapis.com/v3/projects/${ctx.project}/timeSeries`;
      const url = new URL(baseUrl);
      url.searchParams.set(
        "filter",
        `metric.type="${metricType}" AND resource.labels.${resourceLabel}="${resourceValue}"`,
      );
      url.searchParams.set("interval.startTime", startTime);
      url.searchParams.set("interval.endTime", endTime);
      url.searchParams.set("aggregation.alignmentPeriod", "60s");
      url.searchParams.set("aggregation.perSeriesAligner", "ALIGN_MEAN");

      const resp = await ctx.get<GcpTimeSeriesResponse>(url.toString());
      const points = resp.timeSeries?.[0]?.points ?? [];
      if (points.length === 0) return null;
      return {
        label,
        unit,
        points: points.map((p) => ({
          timestamp: new Date(p.interval.endTime).getTime(),
          value: p.value.doubleValue ?? Number(p.value.int64Value ?? 0),
        })),
      };
    } catch {
      return null;
    }
  };

  const resource = await ctx.getResource(resourceTypeId, resourceId, accountId);
  const results: MetricSeries[] = [];

  switch (resourceTypeId) {
    case "gce-instance": {
      // GCE monitoring uses the numeric instance_id resource label
      const numericId = String(resource.fields["numericId"] ?? "");
      if (!numericId) break;
      const series = await Promise.all([
        fetchSeries(
          "compute.googleapis.com/instance/cpu/utilization",
          "instance_id",
          numericId,
          "CPU Utilization",
          "%",
        ),
        fetchSeries(
          "compute.googleapis.com/instance/network/received_bytes_count",
          "instance_id",
          numericId,
          "Network Received",
          "bytes",
        ),
      ]);
      for (const s of series) {
        if (s) results.push(s);
      }
      break;
    }
    case "cloud-run-service":
    case "cloud-function": {
      // Cloud Function gen2 is a Cloud Run service under the hood — same
      // metric types, same `service_name` resource label.
      const serviceName = String(resource.fields["name"] ?? "");
      if (!serviceName) break;
      const series = await Promise.all([
        fetchSeries(
          "run.googleapis.com/request_count",
          "service_name",
          serviceName,
          "Request Count",
          "requests",
        ),
        fetchSeries(
          "run.googleapis.com/request_latencies",
          "service_name",
          serviceName,
          "Request Latency (p95)",
          "ms",
        ),
        fetchSeries(
          "run.googleapis.com/container/instance_count",
          "service_name",
          serviceName,
          "Container Instances",
          "instances",
        ),
        fetchSeries(
          "run.googleapis.com/container/billable_instance_time",
          "service_name",
          serviceName,
          "Billable Instance Time",
          "instance-seconds",
        ),
      ]);
      for (const s of series) {
        if (s) results.push(s);
      }
      break;
    }
    case "cloud-tasks-queue": {
      const queueName = String(resource.fields["name"] ?? "");
      if (!queueName) break;
      const series = await Promise.all([
        fetchSeries(
          "cloudtasks.googleapis.com/queue/dispatch_count",
          "queue_id",
          queueName,
          "Dispatch Count",
          "tasks",
        ),
        fetchSeries(
          "cloudtasks.googleapis.com/queue/depth",
          "queue_id",
          queueName,
          "Queue Depth",
          "tasks",
        ),
        fetchSeries(
          "cloudtasks.googleapis.com/queue/task_attempt_count",
          "queue_id",
          queueName,
          "Task Attempts",
          "attempts",
        ),
      ]);
      for (const s of series) {
        if (s) results.push(s);
      }
      break;
    }
    case "backend-service": {
      // HTTPS/HTTP(2) external load balancers emit metrics on the
      // `https_lb_rule` monitored resource, keyed by `backend_target_name`
      // (the backend service name). For TCP/SSL/UDP LBs the metrics live
      // under different resource types — we surface the HTTPS family here
      // since that covers the common case.
      const name = String(resource.fields["name"] ?? "");
      if (!name) break;
      const fetchLbSeries = async (
        metricType: string,
        label: string,
        unit: string,
      ): Promise<MetricSeries | null> =>
        fetchSeries(metricType, "backend_target_name", name, label, unit);
      const series = await Promise.all([
        fetchLbSeries(
          "loadbalancing.googleapis.com/https/backend_request_count",
          "Backend requests",
          "requests",
        ),
        fetchLbSeries(
          "loadbalancing.googleapis.com/https/backend_latencies",
          "Backend latency",
          "ms",
        ),
        fetchLbSeries(
          "loadbalancing.googleapis.com/https/backend_request_bytes_count",
          "Request bytes",
          "bytes",
        ),
        fetchLbSeries(
          "loadbalancing.googleapis.com/https/backend_response_bytes_count",
          "Response bytes",
          "bytes",
        ),
      ]);
      for (const s of series) {
        if (s) results.push(s);
      }
      break;
    }
    case "cloud-nat": {
      // NAT metrics live on the nat_gateway monitored resource type, keyed
      // by gateway_name (the NAT's name). Allocation level is the headline
      // metric — the rest contextualise traffic and drops.
      const natName = String(resource.fields["name"] ?? "");
      if (!natName) break;
      const series = await Promise.all([
        fetchSeries(
          "router.googleapis.com/nat/port_usage",
          "gateway_name",
          natName,
          "Allocation level",
          "ports",
        ),
        fetchSeries(
          "router.googleapis.com/nat/sent_packets_count",
          "gateway_name",
          natName,
          "Sent packets",
          "packets",
        ),
        fetchSeries(
          "router.googleapis.com/nat/dropped_sent_packets_count",
          "gateway_name",
          natName,
          "Dropped sent packets",
          "packets",
        ),
        fetchSeries(
          "router.googleapis.com/nat/new_connections_count",
          "gateway_name",
          natName,
          "New connections",
          "connections",
        ),
      ]);
      for (const s of series) {
        if (s) results.push(s);
      }
      break;
    }
    case "cloudsql-instance": {
      // Cloud SQL monitored resource label is `database_id` = "<project>:<instance>".
      const instName = String(resource.fields["name"] ?? "");
      if (!instName) break;
      const databaseId = `${ctx.project}:${instName}`;
      const series = await Promise.all([
        fetchSeries(
          "cloudsql.googleapis.com/database/cpu/utilization",
          "database_id",
          databaseId,
          "CPU Utilization",
          "%",
        ),
        fetchSeries(
          "cloudsql.googleapis.com/database/memory/utilization",
          "database_id",
          databaseId,
          "Memory Utilization",
          "%",
        ),
        fetchSeries(
          "cloudsql.googleapis.com/database/disk/utilization",
          "database_id",
          databaseId,
          "Disk Utilization",
          "%",
        ),
        fetchSeries(
          "cloudsql.googleapis.com/database/network/connections",
          "database_id",
          databaseId,
          "Connections",
          "connections",
        ),
      ]);
      for (const s of series) {
        if (s) results.push(s);
      }
      break;
    }
    case "pubsub-topic": {
      const topicId = String(resource.fields["name"] ?? "");
      if (!topicId) break;
      const series = await Promise.all([
        fetchSeries(
          "pubsub.googleapis.com/topic/send_request_count",
          "topic_id",
          topicId,
          "Publish Requests",
          "requests",
        ),
        fetchSeries(
          "pubsub.googleapis.com/topic/byte_cost",
          "topic_id",
          topicId,
          "Byte Cost",
          "bytes",
        ),
        fetchSeries(
          "pubsub.googleapis.com/topic/num_retained_messages",
          "topic_id",
          topicId,
          "Retained Messages",
          "messages",
        ),
      ]);
      for (const s of series) {
        if (s) results.push(s);
      }
      break;
    }
    case "pubsub-subscription": {
      const subId = String(resource.fields["name"] ?? "");
      if (!subId) break;
      const series = await Promise.all([
        fetchSeries(
          "pubsub.googleapis.com/subscription/num_undelivered_messages",
          "subscription_id",
          subId,
          "Undelivered Messages",
          "messages",
        ),
        fetchSeries(
          "pubsub.googleapis.com/subscription/pull_message_operation_count",
          "subscription_id",
          subId,
          "Pull Operations",
          "operations",
        ),
        fetchSeries(
          "pubsub.googleapis.com/subscription/ack_message_count",
          "subscription_id",
          subId,
          "Acked Messages",
          "messages",
        ),
        fetchSeries(
          "pubsub.googleapis.com/subscription/oldest_unacked_message_age",
          "subscription_id",
          subId,
          "Oldest Unacked Age",
          "s",
        ),
      ]);
      for (const s of series) {
        if (s) results.push(s);
      }
      break;
    }
    case "alloydb-instance": {
      // AlloyDB monitored resource has label `instance_id` (instance name only).
      const instId = String(resource.fields["name"] ?? "");
      if (!instId) break;
      const series = await Promise.all([
        fetchSeries(
          "alloydb.googleapis.com/instance/cpu/average_utilization",
          "instance_id",
          instId,
          "CPU Utilization",
          "%",
        ),
        fetchSeries(
          "alloydb.googleapis.com/instance/memory/min_available_memory",
          "instance_id",
          instId,
          "Available Memory",
          "bytes",
        ),
        fetchSeries(
          "alloydb.googleapis.com/instance/postgresql/new_connections_count",
          "instance_id",
          instId,
          "New Connections",
          "connections",
        ),
      ]);
      for (const s of series) {
        if (s) results.push(s);
      }
      break;
    }
    case "memorystore-redis": {
      // Monitored resource `redis_instance`, label `instance_id` is the full
      // resource name including project/location.
      const instName = String(resource.fields["name"] ?? "");
      const region = String(resource.fields["region"] ?? "");
      if (!instName || !region) break;
      const fullName = `projects/${ctx.project}/locations/${region}/instances/${instName}`;
      const series = await Promise.all([
        fetchSeries(
          "redis.googleapis.com/stats/cpu_utilization",
          "instance_id",
          fullName,
          "CPU Utilization",
          "%",
        ),
        fetchSeries(
          "redis.googleapis.com/stats/memory/usage_ratio",
          "instance_id",
          fullName,
          "Memory Usage",
          "%",
        ),
        fetchSeries(
          "redis.googleapis.com/stats/connections/total",
          "instance_id",
          fullName,
          "Connections",
          "connections",
        ),
        fetchSeries(
          "redis.googleapis.com/commands/calls",
          "instance_id",
          fullName,
          "Commands",
          "ops",
        ),
      ]);
      for (const s of series) {
        if (s) results.push(s);
      }
      break;
    }
    case "gke-cluster": {
      // GKE uses monitored resource `k8s_cluster` with label `cluster_name`.
      const clusterName = String(resource.fields["name"] ?? "");
      if (!clusterName) break;
      const series = await Promise.all([
        fetchSeries(
          "kubernetes.io/cluster/node/count",
          "cluster_name",
          clusterName,
          "Node Count",
          "nodes",
        ),
        fetchSeries(
          "kubernetes.io/cluster/pod/count",
          "cluster_name",
          clusterName,
          "Pod Count",
          "pods",
        ),
      ]);
      for (const s of series) {
        if (s) results.push(s);
      }
      break;
    }
  }

  return results;
}

/**
 * Fetch recent log entries for resources that declare a `logs` capability.
 * Currently supports Cloud Tasks queues, Cloud Run services, Cloud Functions,
 * and Cloud Armor policies — queries Cloud Logging with a filter scoped to
 * the relevant resource type. Logs are returned newest-last (so append-style
 * follow rendering puts new lines at the bottom).
 */
export async function getLogs(
  ctx: GcpClientContext,
  typeId: string,
  resourceId: string,
  accountId: string,
  params: LogsFetchParams,
): Promise<LogsFetchResult> {
  if (
    typeId !== "cloud-tasks-queue" &&
    typeId !== "cloud-run-service" &&
    typeId !== "cloud-function" &&
    typeId !== "cloud-armor-policy"
  ) {
    throw new Error(`GCP plugin: getLogs is not supported for ${typeId}`);
  }
  const resource = await ctx.getResource(typeId, resourceId, accountId);
  const name = String(resource.fields["name"] ?? "");
  const region = String(resource.fields["region"] ?? "");
  if (!name) throw new Error(`${typeId} is missing a name`);

  // Cloud Function gen2 logs are written by the underlying Cloud Run service
  // under resource.type="cloud_run_revision" with the same service name.
  // Cloud Armor logs land on the load balancer that the policy is attached
  // to — request logs whose enforcedSecurityPolicy.name matches.
  const filter =
    typeId === "cloud-run-service" || typeId === "cloud-function"
      ? [
          `resource.type="cloud_run_revision"`,
          `resource.labels.service_name="${name}"`,
          ...(region ? [`resource.labels.location="${region}"`] : []),
        ].join(" AND ")
      : typeId === "cloud-armor-policy"
        ? [
            `(resource.type="http_load_balancer" OR resource.type="tcp_ssl_proxy_rule" OR resource.type="l4_proxy_rule")`,
            `jsonPayload.enforcedSecurityPolicy.name="${name}"`,
          ].join(" AND ")
        : [
            `resource.type="cloud_tasks_queue"`,
            `resource.labels.queue_id="${name}"`,
            ...(region
              ? [`resource.labels.target_type=*`, `resource.labels.location="${region}"`]
              : []),
          ].join(" AND ");

  const tok = await ctx.token();
  const tail = Math.max(1, Math.min(params.tailLines ?? 200, 1000));
  const res = await fetch("https://logging.googleapis.com/v2/entries:list", {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      resourceNames: [`projects/${ctx.project}`],
      filter,
      orderBy: "timestamp desc",
      pageSize: tail,
    }),
  });
  if (!res.ok) {
    throw new Error(`Cloud Logging API ${res.status}: ${await res.text()}`);
  }
  interface LogEntry {
    timestamp?: string;
    severity?: string;
    textPayload?: string;
    jsonPayload?: Record<string, unknown>;
    protoPayload?: Record<string, unknown>;
  }
  const data = (await res.json()) as { entries?: LogEntry[] };
  const entries = data.entries ?? [];
  const lines = entries
    .reverse()
    .map((e) => {
      const ts = e.timestamp ?? "";
      const sev = e.severity ?? "DEFAULT";
      const payload =
        e.textPayload ??
        (e.jsonPayload ? JSON.stringify(e.jsonPayload) : "") ??
        (e.protoPayload ? JSON.stringify(e.protoPayload) : "") ??
        "";
      return `${ts} [${sev}] ${payload}`;
    })
    .join("\n");
  const containerLabel =
    typeId === "cloud-run-service" || typeId === "cloud-function"
      ? "service"
      : typeId === "cloud-armor-policy"
        ? "policy"
        : "queue";
  return {
    text: lines || "No log entries in the selected window.",
    containers: [containerLabel],
    activeContainer: containerLabel,
  };
}
