/**
 * Azure Monitor metrics fetcher.
 *
 * Wraps the `Microsoft.Insights/metrics` REST API. Given a resource ID (the
 * fully-qualified ARM path), it queries one or more metric names and returns
 * a normalised MetricSeries shape per metric.
 */
import type { MetricSeries, ResourceInstance } from "@infrawrench/plugin-base";
import { ARM, type AzureHttpContext } from "./shared.js";

interface AzureMetricValue {
  timeStamp: string;
  average?: number;
  total?: number;
  maximum?: number;
  minimum?: number;
  count?: number;
}

interface AzureMetric {
  id: string;
  name: { value: string; localizedValue?: string };
  unit?: string;
  timeseries: Array<{ data: AzureMetricValue[] }>;
}

interface AzureMetricsResponse {
  value: AzureMetric[];
}

interface MetricConfig {
  metricName: string;
  label: string;
  aggregation: "Average" | "Total" | "Maximum" | "Minimum" | "Count";
  unit?: string;
}

const RESOURCE_TYPE_METRICS: Record<string, { provider: string; metrics: MetricConfig[] }> = {
  "azure-vm": {
    provider: "Microsoft.Compute/virtualMachines",
    // All metric names verified against
    // https://learn.microsoft.com/azure/azure-monitor/reference/supported-metrics/microsoft-compute-virtualmachines-metrics
    // Default-aggregation column from the same table.
    metrics: [
      {
        metricName: "Percentage CPU",
        label: "CPU Utilization",
        aggregation: "Average",
        unit: "%",
      },
      {
        metricName: "Network In Total",
        label: "Network In",
        aggregation: "Total",
        unit: "bytes",
      },
      {
        metricName: "Network Out Total",
        label: "Network Out",
        aggregation: "Total",
        unit: "bytes",
      },
      {
        metricName: "Available Memory Bytes",
        label: "Available Memory",
        aggregation: "Average",
        unit: "bytes",
      },
      {
        metricName: "Disk Read Bytes",
        label: "Disk Read",
        aggregation: "Total",
        unit: "bytes",
      },
      {
        metricName: "Disk Write Bytes",
        label: "Disk Write",
        aggregation: "Total",
        unit: "bytes",
      },
    ],
  },
  "azure-sql-database": {
    provider: "Microsoft.Sql/servers/databases",
    // Verified against
    // https://learn.microsoft.com/azure/azure-monitor/reference/supported-metrics/microsoft-sql-servers-databases-metrics
    // DTU-percent only emits for DTU-tier DBs, log_write_percent doesn't
    // emit for data warehouses — the metric API silently returns empty so
    // there's no harm in listing both shapes.
    metrics: [
      { metricName: "cpu_percent", label: "CPU", aggregation: "Average", unit: "%" },
      { metricName: "dtu_consumption_percent", label: "DTU", aggregation: "Average", unit: "%" },
      {
        metricName: "physical_data_read_percent",
        label: "Data IO",
        aggregation: "Average",
        unit: "%",
      },
      { metricName: "log_write_percent", label: "Log IO", aggregation: "Average", unit: "%" },
      {
        metricName: "storage_percent",
        label: "Storage Used",
        aggregation: "Average",
        unit: "%",
      },
      { metricName: "workers_percent", label: "Workers", aggregation: "Average", unit: "%" },
      {
        metricName: "connection_successful",
        label: "Successful Connections",
        aggregation: "Total",
      },
      { metricName: "connection_failed", label: "Failed Connections", aggregation: "Total" },
      { metricName: "deadlock", label: "Deadlocks", aggregation: "Total" },
    ],
  },
  "azure-app-service": {
    provider: "Microsoft.Web/sites",
    // Verified against
    // https://learn.microsoft.com/azure/azure-monitor/reference/supported-metrics/microsoft-web-sites-metrics
    // NOTE: `AverageResponseTime` is marked deprecated in the portal —
    // use `HttpResponseTime` (same shape, seconds, Average) instead.
    metrics: [
      { metricName: "Requests", label: "Requests", aggregation: "Total" },
      {
        metricName: "HttpResponseTime",
        label: "Response Time",
        aggregation: "Average",
        unit: "s",
      },
      { metricName: "Http2xx", label: "2xx Responses", aggregation: "Total" },
      { metricName: "Http4xx", label: "4xx Errors", aggregation: "Total" },
      { metricName: "Http5xx", label: "5xx Errors", aggregation: "Total" },
      { metricName: "CpuTime", label: "CPU Time", aggregation: "Total", unit: "s" },
      { metricName: "MemoryWorkingSet", label: "Memory", aggregation: "Average", unit: "bytes" },
      { metricName: "BytesReceived", label: "Data In", aggregation: "Total", unit: "bytes" },
      { metricName: "BytesSent", label: "Data Out", aggregation: "Total", unit: "bytes" },
      { metricName: "HealthCheckStatus", label: "Health Check", aggregation: "Average" },
    ],
  },
  "azure-function-app": {
    provider: "Microsoft.Web/sites",
    // Function apps share the Web/sites namespace but only emit a subset
    // (Function-prefixed metrics).
    metrics: [
      { metricName: "FunctionExecutionCount", label: "Executions", aggregation: "Total" },
      {
        metricName: "FunctionExecutionUnits",
        label: "Execution Units",
        aggregation: "Total",
      },
      {
        metricName: "HttpResponseTime",
        label: "Response Time",
        aggregation: "Average",
        unit: "s",
      },
      { metricName: "Http5xx", label: "5xx Errors", aggregation: "Total" },
      {
        metricName: "MemoryWorkingSet",
        label: "Memory",
        aggregation: "Average",
        unit: "bytes",
      },
    ],
  },
  "azure-redis-cache": {
    provider: "Microsoft.Cache/redis",
    // Verified against
    // https://learn.microsoft.com/azure/azure-monitor/reference/supported-metrics/microsoft-cache-redis-metrics
    // The portal exposes default aggregation Maximum for the percent metrics
    // (CPU, Server Load, Used Memory %) which masks short spikes better than
    // Average.
    metrics: [
      {
        metricName: "percentProcessorTime",
        label: "CPU",
        aggregation: "Maximum",
        unit: "%",
      },
      {
        metricName: "serverLoad",
        label: "Server Load",
        aggregation: "Maximum",
        unit: "%",
      },
      {
        metricName: "usedmemorypercentage",
        label: "Memory Used",
        aggregation: "Maximum",
        unit: "%",
      },
      { metricName: "usedmemory", label: "Used Memory", aggregation: "Maximum", unit: "bytes" },
      { metricName: "connectedclients", label: "Connected Clients", aggregation: "Maximum" },
      { metricName: "operationsPerSecond", label: "Ops/sec", aggregation: "Maximum" },
      { metricName: "totalcommandsprocessed", label: "Total Commands", aggregation: "Total" },
      { metricName: "cachehits", label: "Cache Hits", aggregation: "Total" },
      { metricName: "cachemisses", label: "Cache Misses", aggregation: "Total" },
      { metricName: "evictedkeys", label: "Evicted Keys", aggregation: "Total" },
      { metricName: "errors", label: "Errors", aggregation: "Maximum" },
    ],
  },
  "azure-postgres-flexible": {
    provider: "Microsoft.DBforPostgreSQL/flexibleServers",
    // Verified against
    // https://learn.microsoft.com/azure/azure-monitor/reference/supported-metrics/microsoft-dbforpostgresql-flexibleservers-metrics
    metrics: [
      { metricName: "cpu_percent", label: "CPU", aggregation: "Average", unit: "%" },
      { metricName: "memory_percent", label: "Memory", aggregation: "Average", unit: "%" },
      {
        metricName: "storage_percent",
        label: "Storage Used",
        aggregation: "Average",
        unit: "%",
      },
      { metricName: "iops", label: "IOPS", aggregation: "Average" },
      {
        metricName: "active_connections",
        label: "Active Connections",
        aggregation: "Average",
      },
      {
        metricName: "connections_succeeded",
        label: "Successful Connections",
        aggregation: "Total",
      },
      { metricName: "connections_failed", label: "Failed Connections", aggregation: "Total" },
      {
        metricName: "network_bytes_ingress",
        label: "Network In",
        aggregation: "Total",
        unit: "bytes",
      },
      {
        metricName: "network_bytes_egress",
        label: "Network Out",
        aggregation: "Total",
        unit: "bytes",
      },
      { metricName: "is_db_alive", label: "Database Alive", aggregation: "Maximum" },
    ],
  },
  "azure-mysql-flexible": {
    provider: "Microsoft.DBforMySQL/flexibleServers",
    // MySQL flexible exposes the same Saturation/Traffic metric vocabulary
    // as Postgres flexible. Verified against
    // https://learn.microsoft.com/azure/azure-monitor/reference/supported-metrics/microsoft-dbformysql-flexibleservers-metrics
    metrics: [
      { metricName: "cpu_percent", label: "CPU", aggregation: "Average", unit: "%" },
      { metricName: "memory_percent", label: "Memory", aggregation: "Average", unit: "%" },
      {
        metricName: "storage_percent",
        label: "Storage Used",
        aggregation: "Average",
        unit: "%",
      },
      {
        metricName: "io_consumption_percent",
        label: "IO Usage",
        aggregation: "Average",
        unit: "%",
      },
      {
        metricName: "active_connections",
        label: "Active Connections",
        aggregation: "Average",
      },
      {
        metricName: "aborted_connections",
        label: "Aborted Connections",
        aggregation: "Total",
      },
      {
        metricName: "network_bytes_ingress",
        label: "Network In",
        aggregation: "Total",
        unit: "bytes",
      },
      {
        metricName: "network_bytes_egress",
        label: "Network Out",
        aggregation: "Total",
        unit: "bytes",
      },
    ],
  },
  "azure-aks-cluster": {
    provider: "Microsoft.ContainerService/managedClusters",
    // Verified against
    // https://learn.microsoft.com/azure/azure-monitor/reference/supported-metrics/microsoft-containerservice-managedclusters-metrics
    metrics: [
      {
        metricName: "node_cpu_usage_percentage",
        label: "Node CPU",
        aggregation: "Average",
        unit: "%",
      },
      {
        metricName: "node_memory_working_set_percentage",
        label: "Node Memory",
        aggregation: "Average",
        unit: "%",
      },
      {
        metricName: "node_disk_usage_percentage",
        label: "Node Disk",
        aggregation: "Average",
        unit: "%",
      },
      { metricName: "kube_pod_status_ready", label: "Pods Ready", aggregation: "Average" },
      { metricName: "kube_pod_status_phase", label: "Pod Phases", aggregation: "Total" },
      {
        metricName: "apiserver_cpu_usage_percentage",
        label: "API Server CPU",
        aggregation: "Maximum",
        unit: "%",
      },
      {
        metricName: "apiserver_memory_usage_percentage",
        label: "API Server Memory",
        aggregation: "Maximum",
        unit: "%",
      },
      {
        metricName: "etcd_database_usage_percentage",
        label: "ETCD Database Used",
        aggregation: "Maximum",
        unit: "%",
      },
      {
        metricName: "cluster_autoscaler_unschedulable_pods_count",
        label: "Unschedulable Pods",
        aggregation: "Total",
      },
    ],
  },
  "azure-cosmos-db": {
    provider: "Microsoft.DocumentDB/databaseAccounts",
    // Verified against
    // https://learn.microsoft.com/azure/azure-monitor/reference/supported-metrics/microsoft-documentdb-databaseaccounts-metrics
    // NOTE: `ServerSideLatency` was deprecated end of August 2025 — replaced
    // by `ServerSideLatencyDirect` / `ServerSideLatencyGateway` per connection
    // mode. We surface both so the user sees whichever applies.
    metrics: [
      { metricName: "TotalRequests", label: "Requests", aggregation: "Total" },
      {
        metricName: "NormalizedRUConsumption",
        label: "Normalized RU",
        aggregation: "Maximum",
        unit: "%",
      },
      { metricName: "TotalRequestUnits", label: "RU Consumed", aggregation: "Total" },
      { metricName: "ProvisionedThroughput", label: "Provisioned RU/s", aggregation: "Maximum" },
      { metricName: "DataUsage", label: "Data Usage", aggregation: "Total", unit: "bytes" },
      {
        metricName: "ServerSideLatencyDirect",
        label: "Latency (Direct)",
        aggregation: "Average",
        unit: "ms",
      },
      {
        metricName: "ServerSideLatencyGateway",
        label: "Latency (Gateway)",
        aggregation: "Average",
        unit: "ms",
      },
    ],
  },
  "azure-storage-account": {
    provider: "Microsoft.Storage/storageAccounts",
    metrics: [
      { metricName: "UsedCapacity", label: "Used Capacity", aggregation: "Average", unit: "bytes" },
      { metricName: "Transactions", label: "Transactions", aggregation: "Total" },
      { metricName: "Ingress", label: "Ingress", aggregation: "Total", unit: "bytes" },
      { metricName: "Egress", label: "Egress", aggregation: "Total", unit: "bytes" },
      { metricName: "Availability", label: "Availability", aggregation: "Average", unit: "%" },
    ],
  },
  "azure-event-hub": {
    provider: "Microsoft.EventHub/namespaces",
    // Verified against
    // https://learn.microsoft.com/azure/azure-monitor/reference/supported-metrics/microsoft-eventhub-namespaces-metrics
    metrics: [
      { metricName: "IncomingMessages", label: "Incoming Messages", aggregation: "Total" },
      { metricName: "OutgoingMessages", label: "Outgoing Messages", aggregation: "Total" },
      { metricName: "IncomingBytes", label: "Incoming Bytes", aggregation: "Total", unit: "bytes" },
      { metricName: "OutgoingBytes", label: "Outgoing Bytes", aggregation: "Total", unit: "bytes" },
      { metricName: "ActiveConnections", label: "Active Connections", aggregation: "Average" },
      { metricName: "ThrottledRequests", label: "Throttled Requests", aggregation: "Total" },
    ],
  },
  "azure-service-bus": {
    provider: "Microsoft.ServiceBus/namespaces",
    // Verified against
    // https://learn.microsoft.com/azure/azure-monitor/reference/supported-metrics/microsoft-servicebus-namespaces-metrics
    metrics: [
      { metricName: "ActiveMessages", label: "Active Messages", aggregation: "Average" },
      {
        metricName: "DeadletteredMessages",
        label: "Dead-lettered Messages",
        aggregation: "Average",
      },
      { metricName: "ScheduledMessages", label: "Scheduled Messages", aggregation: "Average" },
      { metricName: "IncomingMessages", label: "Incoming Messages", aggregation: "Total" },
      { metricName: "OutgoingMessages", label: "Outgoing Messages", aggregation: "Total" },
      { metricName: "Size", label: "Size", aggregation: "Average", unit: "bytes" },
      { metricName: "ActiveConnections", label: "Active Connections", aggregation: "Total" },
      { metricName: "ThrottledRequests", label: "Throttled Requests", aggregation: "Total" },
      { metricName: "ServerErrors", label: "Server Errors", aggregation: "Total" },
      { metricName: "UserErrors", label: "User Errors", aggregation: "Total" },
    ],
  },
  "azure-key-vault": {
    provider: "Microsoft.KeyVault/vaults",
    // Verified against
    // https://learn.microsoft.com/azure/azure-monitor/reference/supported-metrics/microsoft-keyvault-vaults-metrics
    // ServiceApiHit and ServiceApiResult only support the `Count` aggregation
    // (number of samples) — requesting `Total` returns empty.
    metrics: [
      { metricName: "ServiceApiHit", label: "API Hits", aggregation: "Count" },
      { metricName: "ServiceApiLatency", label: "API Latency", aggregation: "Average", unit: "ms" },
      { metricName: "ServiceApiResult", label: "API Results", aggregation: "Count" },
      { metricName: "Availability", label: "Availability", aggregation: "Average", unit: "%" },
      {
        metricName: "SaturationShoebox",
        label: "Vault Saturation",
        aggregation: "Average",
        unit: "%",
      },
    ],
  },
  "azure-container-registry": {
    provider: "Microsoft.ContainerRegistry/registries",
    metrics: [
      { metricName: "TotalPullCount", label: "Pulls", aggregation: "Total" },
      { metricName: "TotalPushCount", label: "Pushes", aggregation: "Total" },
      { metricName: "StorageUsed", label: "Storage Used", aggregation: "Average", unit: "bytes" },
      { metricName: "RunDuration", label: "Run Duration", aggregation: "Total", unit: "ms" },
    ],
  },
  "azure-load-balancer": {
    provider: "Microsoft.Network/loadBalancers",
    // Verified against
    // https://learn.microsoft.com/azure/azure-monitor/reference/supported-metrics/microsoft-network-loadbalancers-metrics
    metrics: [
      { metricName: "ByteCount", label: "Bytes", aggregation: "Total", unit: "bytes" },
      { metricName: "PacketCount", label: "Packets", aggregation: "Total" },
      { metricName: "SnatConnectionCount", label: "SNAT Connections", aggregation: "Total" },
      {
        metricName: "AllocatedSnatPorts",
        label: "Allocated SNAT Ports",
        aggregation: "Average",
      },
      { metricName: "UsedSnatPorts", label: "Used SNAT Ports", aggregation: "Average" },
      {
        metricName: "DipAvailability",
        label: "Backend Health",
        aggregation: "Average",
        unit: "%",
      },
      {
        metricName: "VipAvailability",
        label: "Data Path Availability",
        aggregation: "Average",
        unit: "%",
      },
    ],
  },
  "azure-disk": {
    provider: "Microsoft.Compute/disks",
    // Verified against
    // https://learn.microsoft.com/azure/azure-monitor/reference/supported-metrics/microsoft-compute-disks-metrics
    // The metric names actually contain spaces and a slash — they must be
    // passed verbatim ("Composite Disk Read Bytes/sec").
    metrics: [
      {
        metricName: "Composite Disk Read Bytes/sec",
        label: "Read",
        aggregation: "Average",
        unit: "bytes/s",
      },
      {
        metricName: "Composite Disk Write Bytes/sec",
        label: "Write",
        aggregation: "Average",
        unit: "bytes/s",
      },
      {
        metricName: "Composite Disk Read Operations/sec",
        label: "Read IOPS",
        aggregation: "Average",
      },
      {
        metricName: "Composite Disk Write Operations/sec",
        label: "Write IOPS",
        aggregation: "Average",
      },
    ],
  },
  "azure-app-gateway": {
    provider: "Microsoft.Network/applicationGateways",
    // Verified against
    // https://learn.microsoft.com/azure/azure-monitor/reference/supported-metrics/microsoft-network-applicationgateways-metrics
    metrics: [
      { metricName: "Throughput", label: "Throughput", aggregation: "Average", unit: "bytes/s" },
      { metricName: "TotalRequests", label: "Total Requests", aggregation: "Total" },
      { metricName: "FailedRequests", label: "Failed Requests", aggregation: "Total" },
      { metricName: "ResponseStatus", label: "Response Status", aggregation: "Total" },
      { metricName: "HealthyHostCount", label: "Healthy Hosts", aggregation: "Average" },
      { metricName: "UnhealthyHostCount", label: "Unhealthy Hosts", aggregation: "Average" },
      { metricName: "CpuUtilization", label: "CPU Utilization", aggregation: "Average", unit: "%" },
      { metricName: "CurrentConnections", label: "Current Connections", aggregation: "Total" },
    ],
  },
};

export function azureSupportsMetrics(resourceTypeId: string): boolean {
  return resourceTypeId in RESOURCE_TYPE_METRICS;
}

export async function fetchAzureMetricSeries(
  ctx: AzureHttpContext,
  resource: ResourceInstance,
  resourceTypeId: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const spec = RESOURCE_TYPE_METRICS[resourceTypeId];
  if (!spec) return [];

  // ARM resource id format depends on type. Build from the resource's fields.
  const resourceGroup = String(resource.fields["resourceGroup"] ?? "");
  const name = String(resource.fields["name"] ?? resource.externalId ?? "");
  if (!resourceGroup || !name) return [];

  let resourcePath: string;
  if (resourceTypeId === "azure-sql-database") {
    // SQL Database is a child resource: servers/{serverName}/databases/{name}
    const serverName = String(resource.fields["serverName"] ?? "");
    if (!serverName) return [];
    resourcePath = `subscriptions/${ctx.subscriptionId}/resourceGroups/${resourceGroup}/providers/${spec.provider.replace("/databases", "")}/${serverName}/databases/${name}`;
  } else {
    resourcePath = `subscriptions/${ctx.subscriptionId}/resourceGroups/${resourceGroup}/providers/${spec.provider}/${name}`;
  }

  const now = Date.now();
  const startTime = new Date(timeRange?.startMs ?? now - 3_600_000).toISOString();
  const endTime = new Date(timeRange?.endMs ?? now).toISOString();
  const timespan = `${startTime}/${endTime}`;

  // Pick an interval based on the window: 1m for ≤1h, 5m for ≤6h, 1h for longer.
  const windowMs = (timeRange?.endMs ?? now) - (timeRange?.startMs ?? now - 3_600_000);
  const interval = windowMs <= 3_600_000 ? "PT1M" : windowMs <= 6 * 3_600_000 ? "PT5M" : "PT1H";

  // Azure caps metricnames to 20 per request; we'd never hit that, but group by
  // aggregation since the API needs the aggregation list to match the names.
  const byAgg = new Map<string, MetricConfig[]>();
  for (const m of spec.metrics) {
    if (!byAgg.has(m.aggregation)) byAgg.set(m.aggregation, []);
    byAgg.get(m.aggregation)!.push(m);
  }

  const results: MetricSeries[] = [];

  await Promise.all(
    [...byAgg.entries()].map(async ([agg, metrics]) => {
      try {
        const url = new URL(
          `${ARM}/${resourcePath}/providers/microsoft.insights/metrics?api-version=2018-01-01`,
        );
        url.searchParams.set("metricnames", metrics.map((m) => m.metricName).join(","));
        url.searchParams.set("timespan", timespan);
        url.searchParams.set("interval", interval);
        url.searchParams.set("aggregation", agg.toLowerCase());
        const data = await ctx.get<AzureMetricsResponse>(url.toString());
        for (const am of data.value ?? []) {
          const cfg = metrics.find((m) => m.metricName === am.name.value);
          if (!cfg) continue;
          const data0 = am.timeseries?.[0]?.data ?? [];
          const key = agg.toLowerCase() as keyof AzureMetricValue;
          const points = data0
            .map((p) => ({
              timestamp: new Date(p.timeStamp).getTime(),
              value: Number(p[key] ?? 0),
            }))
            .sort((a, b) => a.timestamp - b.timestamp);
          if (points.length === 0) continue;
          results.push({
            label: cfg.label,
            unit: cfg.unit ?? am.unit ?? "",
            points,
          });
        }
      } catch {
        // Skip — Azure returns 4xx if the metric isn't applicable to this SKU/version.
      }
    }),
  );

  return results;
}
