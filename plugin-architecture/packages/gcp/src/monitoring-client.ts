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
      // Generic fallback: show key fields from the resource
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

/**
 * One Cloud Monitoring series to chart. Every request collapses all matching
 * time series into one line with `crossSeriesReducer`, because most metrics
 * carry labels (response code, storage class, replication role, database)
 * that split a single resource into many series; charting only the first of
 * them silently showed a fraction of the traffic.
 */
interface SeriesSpec {
  /** Full metric type, e.g. `compute.googleapis.com/instance/cpu/utilization`. */
  metric: string;
  label: string;
  unit: string;
  /** Per-series aligner. Defaults to ALIGN_MEAN. */
  aligner?: "ALIGN_MEAN" | "ALIGN_RATE" | "ALIGN_DELTA" | "ALIGN_MAX";
  /** Cross-series reducer. Defaults to REDUCE_SUM. */
  reducer?:
    | "REDUCE_SUM"
    | "REDUCE_MEAN"
    | "REDUCE_MIN"
    | "REDUCE_MAX"
    | "REDUCE_COUNT"
    | "REDUCE_PERCENTILE_95";
  /** Multiplier for every point: fractions to percent, microseconds to ms. */
  scale?: number;
  /** Extra filter clause ANDed onto the resource scope (metric labels). */
  filter?: string;
}

/** DELTA or CUMULATIVE counter charted as a per-second rate summed across labels. */
const rate = (metric: string, label: string, unit: string, filter?: string): SeriesSpec => ({
  metric,
  label,
  unit,
  aligner: "ALIGN_RATE",
  reducer: "REDUCE_SUM",
  ...(filter ? { filter } : {}),
});

/** p95 of a DISTRIBUTION metric across every series in the scope. */
const p95 = (metric: string, label: string, unit: string, scale?: number): SeriesSpec => ({
  metric,
  label,
  unit,
  aligner: "ALIGN_DELTA",
  reducer: "REDUCE_PERCENTILE_95",
  ...(scale !== undefined ? { scale } : {}),
});

/** GAUGE metric; `reducer` picks how labelled series combine (sum by default). */
const gauge = (
  metric: string,
  label: string,
  unit: string,
  opts: Pick<SeriesSpec, "reducer" | "scale" | "filter"> = {},
): SeriesSpec => ({ metric, label, unit, aligner: "ALIGN_MEAN", ...opts });

/** Fractional (0..1) utilization gauges are charted as 0..100 percent. */
const PERCENT = 100;

/**
 * Alignment period scaled to the window so long ranges stay around 300
 * points per series instead of one per minute.
 */
export function alignmentPeriodSeconds(startMs: number, endMs: number): number {
  const rangeSec = Math.max(0, (endMs - startMs) / 1000);
  return Math.max(60, Math.ceil(rangeSec / 300 / 60) * 60);
}

/**
 * The monitored-resource scope plus series list for one resource. Every
 * metric type and label below is from the Google Cloud metrics list
 * (cloud.google.com/monitoring/api/metrics_gcp*) and the monitored resource
 * list (cloud.google.com/monitoring/api/resources).
 */
function metricPlan(
  resourceTypeId: string,
  fields: Record<string, unknown>,
  project: string,
): { scope: string[]; series: SeriesSpec[] } | null {
  const name = String(fields["name"] ?? "");
  const region = String(fields["region"] ?? "");
  const location = String(fields["location"] ?? "");
  const eq = (key: string, value: string) => `resource.labels.${key}="${value}"`;
  const type = (t: string) => `resource.type="${t}"`;

  switch (resourceTypeId) {
    case "gce-instance": {
      // GCE monitoring uses the numeric instance_id resource label.
      const numericId = String(fields["numericId"] ?? "");
      if (!numericId) return null;
      const m = (s: string) => `compute.googleapis.com/instance/${s}`;
      return {
        scope: [type("gce_instance"), eq("instance_id", numericId)],
        series: [
          gauge(m("cpu/utilization"), "CPU Utilization", "%", { scale: PERCENT }),
          rate(m("network/received_bytes_count"), "Network Received", "bytes/s"),
          rate(m("network/sent_bytes_count"), "Network Sent", "bytes/s"),
          rate(m("disk/read_bytes_count"), "Disk Read", "bytes/s"),
          rate(m("disk/write_bytes_count"), "Disk Write", "bytes/s"),
          rate(m("disk/read_ops_count"), "Disk Read Ops", "ops/s"),
          rate(m("disk/write_ops_count"), "Disk Write Ops", "ops/s"),
          // Only populated for e2 machine types.
          gauge(m("memory/balloon/ram_used"), "Memory Used", "bytes"),
        ],
      };
    }
    case "cloud-run-service":
    case "cloud-function": {
      // Cloud Function gen2 is a Cloud Run service under the hood: same
      // metric types, same `service_name` resource label.
      if (!name) return null;
      const m = (s: string) => `run.googleapis.com/${s}`;
      return {
        scope: [
          type("cloud_run_revision"),
          eq("service_name", name),
          ...(region ? [eq("location", region)] : []),
        ],
        series: [
          rate(m("request_count"), "Request Rate", "req/s"),
          rate(
            m("request_count"),
            "5xx Responses",
            "req/s",
            'metric.labels.response_code_class="5xx"',
          ),
          p95(m("request_latencies"), "Request Latency (p95)", "ms"),
          gauge(m("container/instance_count"), "Container Instances", "instances"),
          p95(m("container/cpu/utilizations"), "CPU Utilization (p95)", "%", PERCENT),
          p95(m("container/memory/utilizations"), "Memory Utilization (p95)", "%", PERCENT),
          rate(m("container/network/received_bytes_count"), "Network Received", "bytes/s"),
          rate(m("container/network/sent_bytes_count"), "Network Sent", "bytes/s"),
          p95(m("container/startup_latencies"), "Startup Latency (p95)", "ms"),
          rate(m("container/billable_instance_time"), "Billable Instance Time", "instance-s/s"),
        ],
      };
    }
    case "cloud-run-job": {
      if (!name) return null;
      const m = (s: string) => `run.googleapis.com/${s}`;
      return {
        scope: [
          type("cloud_run_job"),
          eq("job_name", name),
          ...(region ? [eq("location", region)] : []),
        ],
        series: [
          rate(m("job/completed_execution_count"), "Completed Executions", "executions/s"),
          gauge(m("job/running_executions"), "Running Executions", "executions"),
          rate(m("job/completed_task_attempt_count"), "Completed Task Attempts", "attempts/s"),
          gauge(m("job/running_task_attempts"), "Running Task Attempts", "attempts"),
          p95(m("container/cpu/utilizations"), "CPU Utilization (p95)", "%", PERCENT),
          p95(m("container/memory/utilizations"), "Memory Utilization (p95)", "%", PERCENT),
          rate(m("container/billable_instance_time"), "Billable Instance Time", "instance-s/s"),
        ],
      };
    }
    case "cloud-tasks-queue": {
      if (!name) return null;
      const m = (s: string) => `cloudtasks.googleapis.com/${s}`;
      return {
        scope: [
          type("cloud_tasks_queue"),
          eq("queue_id", name),
          ...(region ? [eq("location", region)] : []),
        ],
        series: [
          gauge(m("queue/depth"), "Queue Depth", "tasks"),
          rate(m("queue/task_attempt_count"), "Task Attempts", "attempts/s"),
          p95(m("queue/task_attempt_delays"), "Attempt Delay (p95)", "ms"),
          rate(m("api/request_count"), "API Requests", "req/s"),
        ],
      };
    }
    case "backend-service": {
      // HTTPS/HTTP(2) external load balancers emit metrics on the
      // `https_lb_rule` monitored resource, keyed by `backend_target_name`
      // (the backend service name). For TCP/SSL/UDP LBs the metrics live
      // under different resource types: we surface the HTTPS family here
      // since that covers the common case.
      if (!name) return null;
      const m = (s: string) => `loadbalancing.googleapis.com/https/${s}`;
      return {
        scope: [type("https_lb_rule"), eq("backend_target_name", name)],
        series: [
          rate(m("backend_request_count"), "Backend requests", "req/s"),
          rate(
            m("backend_request_count"),
            "Backend 5xx",
            "req/s",
            "metric.labels.response_code_class=500",
          ),
          p95(m("backend_latencies"), "Backend latency (p95)", "ms"),
          p95(m("total_latencies"), "Total latency (p95)", "ms"),
          rate(m("backend_request_bytes_count"), "Request bytes", "bytes/s"),
          rate(m("backend_response_bytes_count"), "Response bytes", "bytes/s"),
        ],
      };
    }
    case "cloud-nat": {
      // NAT metrics live on the nat_gateway monitored resource type, keyed
      // by gateway_name (the NAT's name).
      if (!name) return null;
      const m = (s: string) => `router.googleapis.com/nat/${s}`;
      return {
        scope: [type("nat_gateway"), eq("gateway_name", name)],
        series: [
          gauge(m("port_usage"), "Port usage (max per VM)", "ports", { reducer: "REDUCE_MAX" }),
          gauge(m("open_connections"), "Open connections", "connections"),
          rate(m("new_connections_count"), "New connections", "connections/s"),
          rate(m("sent_bytes_count"), "Sent bytes", "bytes/s"),
          rate(m("received_bytes_count"), "Received bytes", "bytes/s"),
          rate(m("sent_packets_count"), "Sent packets", "packets/s"),
          rate(m("dropped_sent_packets_count"), "Dropped sent packets", "packets/s"),
          rate(m("dropped_received_packets_count"), "Dropped received packets", "packets/s"),
        ],
      };
    }
    case "cloudsql-instance": {
      // Cloud SQL monitored resource label is `database_id` = "<project>:<instance>".
      if (!name) return null;
      const m = (s: string) => `cloudsql.googleapis.com/database/${s}`;
      return {
        scope: [type("cloudsql_database"), eq("database_id", `${project}:${name}`)],
        series: [
          gauge(m("cpu/utilization"), "CPU Utilization", "%", { scale: PERCENT }),
          gauge(m("memory/utilization"), "Memory Utilization", "%", { scale: PERCENT }),
          gauge(m("disk/utilization"), "Disk Utilization", "%", { scale: PERCENT }),
          gauge(m("disk/bytes_used"), "Disk Used", "bytes"),
          // MySQL and SQL Server report `network/connections`, PostgreSQL
          // reports `postgresql/num_backends`; whichever is empty is dropped.
          gauge(m("network/connections"), "Connections", "connections"),
          gauge(m("postgresql/num_backends"), "PostgreSQL Connections", "connections"),
          rate(m("disk/read_ops_count"), "Disk Read IO", "ops/s"),
          rate(m("disk/write_ops_count"), "Disk Write IO", "ops/s"),
          rate(m("network/received_bytes_count"), "Network Received", "bytes/s"),
          rate(m("network/sent_bytes_count"), "Network Sent", "bytes/s"),
          rate(m("mysql/queries"), "MySQL Queries", "queries/s"),
          rate(m("postgresql/transaction_count"), "PostgreSQL Transactions", "tx/s"),
          gauge(m("replication/replica_lag"), "Replica Lag", "s", { reducer: "REDUCE_MAX" }),
        ],
      };
    }
    case "pubsub-topic": {
      if (!name) return null;
      const m = (s: string) => `pubsub.googleapis.com/topic/${s}`;
      return {
        scope: [type("pubsub_topic"), eq("topic_id", name)],
        series: [
          rate(m("send_request_count"), "Publish Requests", "req/s"),
          p95(m("send_request_latencies"), "Publish Latency (p95)", "ms", 0.001),
          rate(m("byte_cost"), "Byte Cost", "bytes/s"),
          gauge(m("num_retained_messages"), "Retained Messages", "messages"),
          gauge(m("retained_bytes"), "Retained Bytes", "bytes"),
          gauge(m("oldest_retained_message_age"), "Oldest Retained Age", "s", {
            reducer: "REDUCE_MAX",
          }),
        ],
      };
    }
    case "pubsub-subscription": {
      if (!name) return null;
      const m = (s: string) => `pubsub.googleapis.com/subscription/${s}`;
      return {
        scope: [type("pubsub_subscription"), eq("subscription_id", name)],
        series: [
          gauge(m("num_undelivered_messages"), "Undelivered Messages", "messages"),
          gauge(m("backlog_bytes"), "Backlog Size", "bytes"),
          gauge(m("oldest_unacked_message_age"), "Oldest Unacked Age", "s", {
            reducer: "REDUCE_MAX",
          }),
          rate(m("sent_message_count"), "Sent Messages", "msg/s"),
          rate(m("ack_message_count"), "Acked Messages", "msg/s"),
          p95(m("ack_latencies"), "Ack Latency (p95)", "ms"),
          rate(m("pull_request_count"), "Pull Requests", "req/s"),
          rate(m("push_request_count"), "Push Requests", "req/s"),
          rate(m("dead_letter_message_count"), "Dead-Lettered Messages", "msg/s"),
        ],
      };
    }
    case "alloydb-instance": {
      // AlloyDB monitored resource has label `instance_id` (instance name only).
      if (!name) return null;
      const m = (s: string) => `alloydb.googleapis.com/instance/${s}`;
      return {
        scope: [type("alloydb.googleapis.com/Instance"), eq("instance_id", name)],
        series: [
          // Already 0..100, unlike most `10^2.%` gauges.
          gauge(m("cpu/average_utilization"), "CPU Utilization", "%", {
            reducer: "REDUCE_MEAN",
          }),
          gauge(m("memory/min_available_memory"), "Available Memory", "bytes", {
            reducer: "REDUCE_MIN",
          }),
          gauge(m("postgres/total_connections"), "Connections", "connections"),
          rate(m("postgresql/new_connections_count"), "New Connections", "connections/s"),
          rate(m("postgres/transaction_count"), "Transactions", "tx/s"),
        ],
      };
    }
    case "memorystore-redis": {
      // Monitored resource `redis_instance`; its `instance_id` label is the
      // full resource name including project/location.
      if (!name || !region) return null;
      const m = (s: string) => `redis.googleapis.com/${s}`;
      return {
        scope: [
          type("redis_instance"),
          eq("instance_id", `projects/${project}/locations/${region}/instances/${name}`),
        ],
        series: [
          // `stats/cpu_utilization` is CPU-seconds consumed, so its rate is
          // the number of vCPUs kept busy.
          rate(m("stats/cpu_utilization"), "CPU Usage", "vCPU"),
          gauge(m("stats/memory/usage_ratio"), "Memory Usage", "%", {
            reducer: "REDUCE_MAX",
            scale: PERCENT,
          }),
          gauge(m("clients/connected"), "Connected Clients", "clients"),
          rate(m("commands/calls"), "Commands", "ops/s"),
          gauge(m("stats/cache_hit_ratio"), "Cache Hit Ratio", "%", {
            reducer: "REDUCE_MEAN",
            scale: PERCENT,
          }),
          gauge(m("keyspace/keys"), "Keys", "keys", { reducer: "REDUCE_MAX" }),
          rate(m("stats/evicted_keys"), "Evicted Keys", "keys/s"),
          rate(m("stats/network_traffic"), "Network Traffic", "bytes/s"),
        ],
      };
    }
    case "memorystore-valkey": {
      // Monitored resource `memorystore.googleapis.com/Instance`; its
      // `instance_id` label is the short instance id. The instance-level
      // series aggregate across every node and shard.
      if (!name) return null;
      const m = (s: string) => `memorystore.googleapis.com/instance/${s}`;
      const mean = { reducer: "REDUCE_MEAN" as const, scale: PERCENT };
      return {
        scope: [type("memorystore.googleapis.com/Instance"), eq("instance_id", name)],
        series: [
          gauge(m("cpu/average_utilization"), "CPU Utilization", "%", mean),
          gauge(m("memory/average_utilization"), "Memory Utilization", "%", mean),
          gauge(m("memory/total_used_memory"), "Used Memory", "bytes"),
          gauge(m("clients/total_connected_clients"), "Connected Clients", "clients"),
          rate(m("commandstats/total_calls_count"), "Commands", "ops/s"),
          gauge(m("keyspace/total_keys"), "Keys", "keys"),
          rate(m("stats/total_keyspace_hits_count"), "Keyspace Hits", "hits/s"),
          rate(m("stats/total_keyspace_misses_count"), "Keyspace Misses", "misses/s"),
          rate(m("stats/total_evicted_keys_count"), "Evicted Keys", "keys/s"),
          rate(m("stats/total_net_input_bytes_count"), "Network In", "bytes/s"),
          rate(m("stats/total_net_output_bytes_count"), "Network Out", "bytes/s"),
        ],
      };
    }
    case "memorystore-memcached": {
      // `memcache_node`, one series per node; `instance_id` is the short id.
      if (!name) return null;
      const m = (s: string) => `memcache.googleapis.com/node/${s}`;
      return {
        scope: [type("memcache_node"), eq("instance_id", name)],
        series: [
          gauge(m("cpu/utilization"), "CPU Utilization", "%", {
            reducer: "REDUCE_MEAN",
            scale: PERCENT,
          }),
          gauge(m("hit_ratio"), "Hit Ratio", "%", { reducer: "REDUCE_MEAN", scale: PERCENT }),
          gauge(m("items"), "Items", "items"),
          gauge(m("active_connections"), "Active Connections", "connections"),
          rate(m("operation_count"), "Operations", "ops/s"),
          rate(m("eviction_count"), "Evictions", "items/s"),
          rate(m("received_bytes_count"), "Received", "bytes/s"),
          rate(m("sent_bytes_count"), "Sent", "bytes/s"),
        ],
      };
    }
    case "gke-cluster": {
      // Node and container series all carry `cluster_name` and `location`.
      if (!name) return null;
      const m = (s: string) => `kubernetes.io/${s}`;
      const scope = (t: string) => [
        type(t),
        eq("cluster_name", name),
        ...(location ? [eq("location", location)] : []),
      ];
      return {
        scope: [],
        series: [
          // One series per node, so counting series counts nodes.
          {
            ...gauge(m("node/cpu/allocatable_utilization"), "Node Count", "nodes"),
            reducer: "REDUCE_COUNT",
            filter: scope("k8s_node").join(" AND "),
          },
          gauge(m("node/cpu/allocatable_utilization"), "Node CPU (allocatable)", "%", {
            reducer: "REDUCE_MEAN",
            scale: PERCENT,
            filter: scope("k8s_node").join(" AND "),
          }),
          {
            ...rate(m("node/cpu/core_usage_time"), "CPU Usage", "cores"),
            filter: scope("k8s_node").join(" AND "),
          },
          gauge(m("node/memory/used_bytes"), "Memory Used", "bytes", {
            filter: scope("k8s_node").join(" AND "),
          }),
          {
            ...rate(m("node/network/received_bytes_count"), "Network Received", "bytes/s"),
            filter: scope("k8s_node").join(" AND "),
          },
          {
            ...rate(m("node/network/sent_bytes_count"), "Network Sent", "bytes/s"),
            filter: scope("k8s_node").join(" AND "),
          },
          {
            metric: m("container/restart_count"),
            label: "Container Restarts",
            unit: "restarts",
            aligner: "ALIGN_DELTA",
            reducer: "REDUCE_SUM",
            filter: scope("k8s_container").join(" AND "),
          },
        ],
      };
    }
    case "gcs-bucket": {
      if (!name) return null;
      const m = (s: string) => `storage.googleapis.com/${s}`;
      return {
        scope: [type("gcs_bucket"), eq("bucket_name", name)],
        series: [
          // Measured once a day and repeated through it; v2 includes
          // noncurrent, soft-deleted and multipart-upload bytes.
          gauge(m("storage/v2/total_bytes"), "Total Bytes", "bytes"),
          gauge(m("storage/v2/total_count"), "Object Count", "objects"),
          rate(m("api/request_count"), "API Requests", "req/s"),
          rate(m("network/sent_bytes_count"), "Sent", "bytes/s"),
          rate(m("network/received_bytes_count"), "Received", "bytes/s"),
        ],
      };
    }
    case "bigquery-dataset": {
      if (!name) return null;
      const m = (s: string) => `bigquery.googleapis.com/storage/${s}`;
      return {
        scope: [type("bigquery_dataset"), eq("dataset_id", name)],
        series: [
          gauge(m("stored_bytes"), "Stored Bytes", "bytes"),
          gauge(m("table_count"), "Tables", "tables"),
          rate(m("uploaded_bytes"), "Uploaded", "bytes/s"),
        ],
      };
    }
    case "spanner-instance": {
      if (!name) return null;
      const m = (s: string) => `spanner.googleapis.com/${s}`;
      return {
        scope: [type("spanner_instance"), eq("instance_id", name)],
        series: [
          // Per-database CPU; the sum is the instance's utilization.
          gauge(m("instance/cpu/utilization"), "CPU Utilization", "%", { scale: PERCENT }),
          gauge(m("instance/storage/used_bytes"), "Storage Used", "bytes"),
          gauge(m("instance/node_count"), "Nodes", "nodes"),
          gauge(m("instance/processing_units"), "Processing Units", "PU"),
          gauge(m("instance/session_count"), "Sessions", "sessions"),
          // Already a rate gauge (1/s), so it is averaged rather than rated.
          gauge(m("api/request_count"), "API Requests", "req/s"),
          p95(m("api/request_latencies"), "Request Latency (p95)", "ms", 1000),
        ],
      };
    }
    case "bigtable-instance": {
      if (!name) return null;
      const m = (s: string) => `bigtable.googleapis.com/${s}`;
      const cluster = [type("bigtable_cluster"), eq("instance", name)].join(" AND ");
      const table = [type("bigtable_table"), eq("instance", name)].join(" AND ");
      return {
        scope: [],
        series: [
          gauge(m("cluster/cpu_load"), "CPU Load (busiest cluster)", "%", {
            reducer: "REDUCE_MAX",
            scale: PERCENT,
            filter: cluster,
          }),
          gauge(m("cluster/storage_utilization"), "Storage Utilization", "%", {
            reducer: "REDUCE_MAX",
            scale: PERCENT,
            filter: cluster,
          }),
          gauge(m("cluster/node_count"), "Nodes", "nodes", { filter: cluster }),
          gauge(m("table/bytes_used"), "Data Stored", "bytes", { filter: table }),
          { ...rate(m("server/request_count"), "Requests", "req/s"), filter: table },
          { ...rate(m("server/error_count"), "Errors", "req/s"), filter: table },
          { ...p95(m("server/latencies"), "Server Latency (p95)", "ms"), filter: table },
          {
            ...rate(m("server/received_bytes_count"), "Received", "bytes/s"),
            filter: table,
          },
          { ...rate(m("server/sent_bytes_count"), "Sent", "bytes/s"), filter: table },
        ],
      };
    }
    case "filestore-instance": {
      if (!name) return null;
      const m = (s: string) => `file.googleapis.com/nfs/server/${s}`;
      return {
        scope: [
          type("filestore_instance"),
          eq("instance_name", name),
          ...(location ? [eq("location", location)] : []),
        ],
        series: [
          // Already 0..100.
          gauge(m("used_bytes_percent"), "Used Space", "%", { reducer: "REDUCE_MAX" }),
          gauge(m("free_bytes"), "Free Space", "bytes"),
          rate(m("read_ops_count"), "Read Ops", "ops/s"),
          rate(m("write_ops_count"), "Write Ops", "ops/s"),
          rate(m("read_bytes_count"), "Read", "bytes/s"),
          rate(m("write_bytes_count"), "Write", "bytes/s"),
          // Not populated for Basic tier instances.
          gauge(m("average_read_latency"), "Read Latency", "ms", { reducer: "REDUCE_MEAN" }),
          gauge(m("average_write_latency"), "Write Latency", "ms", { reducer: "REDUCE_MEAN" }),
        ],
      };
    }
    case "vertex-ai-endpoint": {
      // `name` is the full `projects/…/endpoints/<id>` path; the monitored
      // resource is keyed by the trailing numeric id.
      const endpointId = name.split("/").pop() ?? "";
      if (!endpointId) return null;
      const m = (s: string) => `aiplatform.googleapis.com/prediction/online/${s}`;
      return {
        scope: [
          type("aiplatform.googleapis.com/Endpoint"),
          eq("endpoint_id", endpointId),
          ...(region ? [eq("location", region)] : []),
        ],
        series: [
          rate(m("prediction_count"), "Predictions", "predictions/s"),
          rate(m("error_count"), "Errors", "errors/s"),
          {
            ...p95(m("prediction_latencies"), "Prediction Latency (p95)", "ms"),
            filter: 'metric.labels.latency_type="total"',
          },
          gauge(m("replicas"), "Replicas", "replicas"),
          gauge(m("cpu/utilization"), "CPU Utilization", "%", {
            reducer: "REDUCE_MEAN",
            scale: PERCENT,
          }),
        ],
      };
    }
    case "workflow": {
      if (!name) return null;
      const m = (s: string) => `workflows.googleapis.com/${s}`;
      return {
        scope: [
          type("workflows.googleapis.com/Workflow"),
          eq("workflow_id", name),
          ...(region ? [eq("location", region)] : []),
        ],
        series: [
          rate(m("started_execution_count"), "Started Executions", "executions/s"),
          rate(m("finished_execution_count"), "Finished Executions", "executions/s"),
          p95(m("execution_times"), "Execution Time (p95)", "s"),
          gauge(m("execution_backlog_size"), "Execution Backlog", "executions"),
          rate(m("internal_execution_error_count"), "Internal Errors", "executions/s"),
          rate(m("io_step_count"), "I/O Steps", "steps/s"),
        ],
      };
    }
    case "dataflow-job": {
      // `dataflow_job` is keyed by job name and region; a name is unique
      // among a region's active jobs, which is all the lister returns.
      if (!name) return null;
      const m = (s: string) => `dataflow.googleapis.com/job/${s}`;
      return {
        scope: [
          type("dataflow_job"),
          eq("job_name", name),
          ...(region ? [eq("region", region)] : []),
        ],
        series: [
          gauge(m("current_num_vcpus"), "vCPUs in Use", "vCPU"),
          gauge(m("system_lag"), "System Lag", "s", { reducer: "REDUCE_MAX" }),
          gauge(m("data_watermark_age"), "Data Watermark Lag", "s", { reducer: "REDUCE_MAX" }),
          gauge(m("backlog_bytes"), "Backlog", "bytes"),
          rate(m("elements_produced_count"), "Elements Produced", "elements/s"),
          gauge(m("total_vcpu_time"), "Total vCPU Time", "vCPU-s"),
          gauge(m("total_memory_usage_time"), "Total Memory Time", "GB-s"),
        ],
      };
    }
    case "app-engine-service": {
      if (!name) return null;
      const m = (s: string) => `appengine.googleapis.com/${s}`;
      return {
        scope: [type("gae_app"), eq("module_id", name)],
        series: [
          rate(m("http/server/response_count"), "Responses", "req/s"),
          p95(m("http/server/response_latencies"), "Response Latency (p95)", "ms"),
          gauge(m("system/instance_count"), "Instances", "instances"),
          gauge(m("system/billed_instance_estimate_count"), "Billed Instances (est.)", "instances"),
          gauge(m("system/memory/usage"), "Memory Used", "bytes"),
          rate(m("system/network/received_bytes_count"), "Received", "bytes/s"),
          rate(m("system/network/sent_bytes_count"), "Sent", "bytes/s"),
        ],
      };
    }
    case "composer-environment": {
      if (!name) return null;
      const m = (s: string) => `composer.googleapis.com/environment/${s}`;
      return {
        scope: [
          type("cloud_composer_environment"),
          eq("environment_name", name),
          ...(location ? [eq("location", location)] : []),
        ],
        series: [
          gauge(m("num_celery_workers"), "Celery Workers", "workers"),
          gauge(m("unfinished_task_instances"), "Unfinished Tasks", "tasks"),
          rate(m("finished_task_instance_count"), "Finished Tasks", "tasks/s"),
          gauge(m("dagbag_size"), "DAG Bag Size", "DAGs"),
          gauge(m("dag_processing/total_parse_time"), "DAG Parse Time", "s", {
            reducer: "REDUCE_MAX",
          }),
          rate(m("scheduler_heartbeat_count"), "Scheduler Heartbeats", "beats/s"),
          gauge(m("database/cpu/utilization"), "Database CPU", "%", {
            reducer: "REDUCE_MEAN",
            scale: PERCENT,
          }),
        ],
      };
    }
  }
  return null;
}

export async function fetchMetricSeries(
  ctx: GcpClientContext,
  resourceTypeId: string,
  resourceId: string,
  accountId: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const now = Date.now();
  const startMs = timeRange?.startMs ?? now - 3_600_000;
  const endMs = timeRange?.endMs ?? now;
  const startTime = new Date(startMs).toISOString();
  const endTime = new Date(endMs).toISOString();
  const period = `${alignmentPeriodSeconds(startMs, endMs)}s`;

  interface GcpTimeSeriesPoint {
    interval: { startTime?: string; endTime: string };
    value: { doubleValue?: number; int64Value?: string };
  }
  interface GcpTimeSeries {
    points?: GcpTimeSeriesPoint[];
  }
  interface GcpTimeSeriesResponse {
    timeSeries?: GcpTimeSeries[];
  }

  const resource = await ctx.getResource(resourceTypeId, resourceId, accountId);
  const plan = metricPlan(resourceTypeId, resource.fields, ctx.project);
  if (!plan) return [];

  const fetchSeries = async (spec: SeriesSpec): Promise<MetricSeries | null> => {
    try {
      const url = new URL(
        `https://monitoring.googleapis.com/v3/projects/${ctx.project}/timeSeries`,
      );
      const clauses = [`metric.type="${spec.metric}"`, ...plan.scope];
      if (spec.filter) clauses.push(spec.filter);
      url.searchParams.set("filter", clauses.join(" AND "));
      url.searchParams.set("interval.startTime", startTime);
      url.searchParams.set("interval.endTime", endTime);
      url.searchParams.set("aggregation.alignmentPeriod", period);
      url.searchParams.set("aggregation.perSeriesAligner", spec.aligner ?? "ALIGN_MEAN");
      url.searchParams.set("aggregation.crossSeriesReducer", spec.reducer ?? "REDUCE_SUM");

      const resp = await ctx.get<GcpTimeSeriesResponse>(url.toString());
      const points = resp.timeSeries?.[0]?.points ?? [];
      if (points.length === 0) return null;
      const scale = spec.scale ?? 1;
      return {
        label: spec.label,
        unit: spec.unit,
        // The API returns newest first; charts want oldest first.
        points: points
          .map((p) => ({
            timestamp: new Date(p.interval.endTime).getTime(),
            value: (p.value.doubleValue ?? Number(p.value.int64Value ?? 0)) * scale,
          }))
          .sort((a, b) => a.timestamp - b.timestamp),
      };
    } catch {
      return null;
    }
  };

  const series = await Promise.all(plan.series.map(fetchSeries));
  return series.filter((s): s is MetricSeries => s !== null);
}

/**
 * Cloud Logging scope per resource type, plus the label the Logs tab's
 * container picker shows. Resource types and labels are from the logging
 * monitored-resource list (cloud.google.com/logging/docs/api/v2/resource-list).
 */
function logScope(
  typeId: string,
  fields: Record<string, unknown>,
  externalId: string,
  project: string,
): { filter: string; container: string } | null {
  const name = String(fields["name"] ?? "");
  const region = String(fields["region"] ?? "");
  const location = String(fields["location"] ?? "");
  const eq = (key: string, value: string) => `resource.labels.${key}="${value}"`;
  const type = (t: string) => `resource.type="${t}"`;
  const at = (key: string, value: string) => (value ? [eq(key, value)] : []);
  const scope = (container: string, ...clauses: string[]) => ({
    filter: clauses.join(" AND "),
    container,
  });

  switch (typeId) {
    case "cloud-run-job":
      if (!name) return null;
      return scope("job", type("cloud_run_job"), eq("job_name", name), ...at("location", region));
    case "cloud-run-service":
    case "cloud-function":
      // Cloud Function gen2 logs are written by the underlying Cloud Run
      // service under cloud_run_revision with the same service name.
      if (!name) return null;
      return scope(
        "service",
        type("cloud_run_revision"),
        eq("service_name", name),
        ...at("location", region),
      );
    case "cloud-armor-policy":
      // Cloud Armor logs land on the load balancer the policy is attached
      // to: request logs whose enforcedSecurityPolicy.name matches.
      if (!name) return null;
      return scope(
        "policy",
        `(resource.type="http_load_balancer" OR resource.type="tcp_ssl_proxy_rule" OR resource.type="l4_proxy_rule")`,
        `jsonPayload.enforcedSecurityPolicy.name="${name}"`,
      );
    case "cloud-tasks-queue":
      if (!name) return null;
      return scope(
        "queue",
        type("cloud_tasks_queue"),
        eq("queue_id", name),
        ...at("location", region),
      );
    case "gce-instance": {
      // Serial console, guest agent and Ops Agent logs, keyed by numeric id.
      const numericId = String(fields["numericId"] ?? "");
      if (!numericId) return null;
      return scope("instance", type("gce_instance"), eq("instance_id", numericId));
    }
    case "gke-cluster":
      // Container stdout/stderr, pod and node events, and the cluster's
      // audit logs all carry cluster_name and location.
      if (!name) return null;
      return scope(
        "cluster",
        `(resource.type="k8s_container" OR resource.type="k8s_pod" OR resource.type="k8s_node" OR resource.type="k8s_cluster")`,
        eq("cluster_name", name),
        ...at("location", location),
      );
    case "cloudsql-instance":
      if (!name) return null;
      return scope("database", type("cloudsql_database"), eq("database_id", `${project}:${name}`));
    case "cloud-scheduler-job":
      if (!name) return null;
      return scope(
        "job",
        type("cloud_scheduler_job"),
        eq("job_id", name),
        ...at("location", region),
      );
    case "workflow":
      if (!name) return null;
      return scope(
        "workflow",
        type("workflows.googleapis.com/Workflow"),
        eq("workflow_id", name),
        ...at("location", region),
      );
    case "dataflow-job":
      // Job and worker logs are written per step, keyed by the job id.
      if (!externalId) return null;
      return scope("job", type("dataflow_step"), eq("job_id", externalId));
    case "app-engine-service":
      if (!name) return null;
      return scope("service", type("gae_app"), eq("module_id", name));
    case "composer-environment":
      if (!name) return null;
      return scope(
        "environment",
        type("cloud_composer_environment"),
        eq("environment_name", name),
        ...at("location", location),
      );
  }
  return null;
}

/** Resource types `getLogs` can scope; their detail views get a Logs tab. */
export const GCP_LOG_TYPES: ReadonlySet<string> = new Set([
  "cloud-tasks-queue",
  "cloud-run-service",
  "cloud-function",
  "cloud-run-job",
  "cloud-armor-policy",
  "gce-instance",
  "gke-cluster",
  "cloudsql-instance",
  "cloud-scheduler-job",
  "workflow",
  "dataflow-job",
  "app-engine-service",
  "composer-environment",
]);

/**
 * Fetch recent log entries for resources that declare a `logs` capability
 * by querying Cloud Logging with a filter scoped to the resource (see
 * `logScope`). Logs are returned newest-last (so append-style follow
 * rendering puts new lines at the bottom).
 */
export async function getLogs(
  ctx: GcpClientContext,
  typeId: string,
  resourceId: string,
  accountId: string,
  params: LogsFetchParams,
): Promise<LogsFetchResult> {
  if (!GCP_LOG_TYPES.has(typeId)) {
    throw new Error(`GCP plugin: getLogs is not supported for ${typeId}`);
  }
  const resource = await ctx.getResource(typeId, resourceId, accountId);
  const logScopeResult = logScope(typeId, resource.fields, resource.externalId ?? "", ctx.project);
  if (!logScopeResult) throw new Error(`${typeId} is missing the identifier its logs are keyed by`);
  const { filter, container: containerLabel } = logScopeResult;

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
        (e.jsonPayload
          ? JSON.stringify(e.jsonPayload)
          : e.protoPayload
            ? JSON.stringify(e.protoPayload)
            : "");
      return `${ts} [${sev}] ${payload}`;
    })
    .join("\n");
  return {
    text: lines || "No log entries in the selected window.",
    containers: [containerLabel],
    activeContainer: containerLabel,
  };
}
