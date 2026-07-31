import type { MetricSeries, ResourceInstance } from "@infrawrench/plugin-base";
import { ARM, AZURE_ARM_SPECS, type AzureHttpContext } from "./shared.js";

interface MetricDescriptor {
  name: string;
  label: string;
}

const METRICS_BY_TYPE: Record<string, MetricDescriptor[]> = {
  "azure-vm": [
    { name: "Percentage CPU", label: "CPU" },
    { name: "Available Memory Bytes", label: "Available memory" },
    { name: "Disk Read Bytes", label: "Disk read" },
    { name: "Disk Write Bytes", label: "Disk write" },
    { name: "Network In Total", label: "Network in" },
    { name: "Network Out Total", label: "Network out" },
  ],
  "azure-disk": [
    { name: "Composite Disk Read Bytes/sec", label: "Read bytes/sec" },
    { name: "Composite Disk Write Bytes/sec", label: "Write bytes/sec" },
    { name: "Composite Disk Read Operations/sec", label: "Read ops/sec" },
    { name: "Composite Disk Write Operations/sec", label: "Write ops/sec" },
  ],
  "azure-aks-cluster": [
    { name: "node_cpu_usage_percentage", label: "Node CPU" },
    { name: "node_memory_working_set_percentage", label: "Node memory" },
  ],
  "azure-sql-database": [
    { name: "cpu_percent", label: "CPU" },
    { name: "dtu_consumption_percent", label: "DTU" },
    { name: "storage_percent", label: "Storage" },
    { name: "deadlock", label: "Deadlocks" },
  ],
  "azure-cosmos-db": [
    { name: "TotalRequests", label: "Requests" },
    { name: "TotalRequestUnits", label: "Request units" },
    { name: "DataUsage", label: "Data usage" },
    { name: "IndexUsage", label: "Index usage" },
  ],
  "azure-storage-account": [
    { name: "UsedCapacity", label: "Used capacity" },
    { name: "Transactions", label: "Transactions" },
    { name: "Ingress", label: "Ingress" },
    { name: "Egress", label: "Egress" },
    { name: "SuccessE2ELatency", label: "E2E latency" },
  ],
  "azure-function-app": [
    { name: "FunctionExecutionCount", label: "Executions" },
    { name: "FunctionExecutionUnits", label: "Execution units" },
    { name: "CpuTime", label: "CPU time" },
    { name: "Requests", label: "Requests" },
  ],
  "azure-app-service": [
    { name: "CpuTime", label: "CPU time" },
    { name: "Requests", label: "Requests" },
    { name: "AverageMemoryWorkingSet", label: "Memory working set" },
    { name: "Http5xx", label: "HTTP 5xx" },
  ],
  "azure-app-service-plan": [
    { name: "CpuPercentage", label: "CPU" },
    { name: "MemoryPercentage", label: "Memory" },
    { name: "DiskQueueLength", label: "Disk queue length" },
    { name: "HttpQueueLength", label: "HTTP queue length" },
    { name: "BytesReceived", label: "Data in" },
    { name: "BytesSent", label: "Data out" },
  ],
  "azure-container-instance": [
    { name: "CpuUsage", label: "CPU" },
    { name: "MemoryUsage", label: "Memory" },
    { name: "NetworkBytesReceivedPerSecond", label: "Network received" },
    { name: "NetworkBytesTransmittedPerSecond", label: "Network transmitted" },
  ],
  "azure-key-vault": [
    { name: "ServiceApiHit", label: "API hits" },
    { name: "ServiceApiLatency", label: "API latency" },
    { name: "SaturationShoebox", label: "Saturation" },
  ],
  "azure-redis-cache": [
    { name: "cachehits", label: "Cache hits" },
    { name: "cachemisses", label: "Cache misses" },
    { name: "usedmemory", label: "Used memory" },
    { name: "connectedclients", label: "Connected clients" },
  ],
  "azure-service-bus": [
    { name: "IncomingMessages", label: "Incoming messages" },
    { name: "OutgoingMessages", label: "Outgoing messages" },
    { name: "ActiveMessages", label: "Active messages" },
    { name: "Size", label: "Size" },
  ],
  "azure-event-hub": [
    { name: "IncomingMessages", label: "Incoming messages" },
    { name: "OutgoingMessages", label: "Outgoing messages" },
    { name: "IncomingBytes", label: "Incoming bytes" },
    { name: "OutgoingBytes", label: "Outgoing bytes" },
  ],
  "azure-container-registry": [
    { name: "StorageUsed", label: "Storage used" },
    { name: "PullCount", label: "Pull count" },
    { name: "PushCount", label: "Push count" },
  ],
  "azure-load-balancer": [
    { name: "DipAvailability", label: "Backend availability" },
    { name: "VipAvailability", label: "Frontend availability" },
    { name: "ByteCount", label: "Bytes" },
    { name: "PacketCount", label: "Packets" },
  ],
  "azure-app-gateway": [
    { name: "Throughput", label: "Throughput" },
    { name: "CurrentConnections", label: "Connections" },
    { name: "FailedRequests", label: "Failed requests" },
    { name: "UnhealthyHostCount", label: "Unhealthy hosts" },
  ],
  "azure-nat-gateway": [
    { name: "DatapathAvailability", label: "Datapath availability" },
    { name: "SNATConnectionCount", label: "SNAT connections" },
    { name: "TotalConnectionCount", label: "Connections" },
    { name: "ByteCount", label: "Bytes" },
  ],
  "azure-public-ip": [
    { name: "ByteCount", label: "Bytes" },
    { name: "PacketCount", label: "Packets" },
    { name: "SYNCount", label: "SYN count" },
  ],
  "azure-postgres-flexible": [
    { name: "cpu_percent", label: "CPU" },
    { name: "memory_percent", label: "Memory" },
    { name: "storage_percent", label: "Storage" },
    { name: "active_connections", label: "Active connections" },
    { name: "iops", label: "IOPS" },
  ],
  "azure-mysql-flexible": [
    { name: "cpu_percent", label: "CPU" },
    { name: "memory_percent", label: "Memory" },
    { name: "storage_percent", label: "Storage" },
    { name: "active_connections", label: "Active connections" },
    { name: "io_consumption_percent", label: "IO consumption" },
  ],
  "azure-firewall": [
    { name: "ApplicationRuleHit", label: "Application rule hits" },
    { name: "NetworkRuleHit", label: "Network rule hits" },
    { name: "DataProcessed", label: "Data processed" },
  ],
  "azure-dns-zone": [
    { name: "QueryVolume", label: "Query volume" },
    { name: "RecordSetCapacityUtilization", label: "Record-set capacity" },
  ],
  "azure-private-dns-zone": [
    { name: "QueryVolume", label: "Query volume" },
    { name: "RecordSetCapacityUtilization", label: "Record-set capacity" },
    { name: "VirtualNetworkLinkCapacityUtilization", label: "VNet-link capacity" },
  ],
  "azure-log-analytics": [
    { name: "IngestionVolume", label: "Ingestion volume" },
    { name: "IngestionLatency", label: "Ingestion latency" },
    { name: "DailyQuotaUsedPercentage", label: "Daily quota used" },
  ],
};

interface AzureMetricsResponse {
  value?: Array<{
    name?: { value?: string; localizedValue?: string };
    unit?: string;
    timeseries?: Array<{ data?: AzureMetricPoint[] }>;
  }>;
}

interface AzureMetricPoint {
  timeStamp?: string;
  average?: number;
  total?: number;
  maximum?: number;
  minimum?: number;
  count?: number;
}

export async function fetchAzureMetricSeries(
  ctx: AzureHttpContext,
  resourceTypeId: string,
  resource: ResourceInstance,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const descriptors = METRICS_BY_TYPE[resourceTypeId] ?? [];
  const azureResourceId = buildAzureResourceId(ctx, resourceTypeId, resource);
  if (!descriptors.length || !azureResourceId) return [];

  const startMs = timeRange?.startMs ?? Date.now() - 60 * 60 * 1000;
  const endMs = timeRange?.endMs ?? Date.now();
  const timespan = `${new Date(startMs).toISOString()}/${new Date(endMs).toISOString()}`;
  const series: MetricSeries[] = [];

  for (const descriptor of descriptors) {
    const url =
      `${ARM}${azureResourceId}/providers/Microsoft.Insights/metrics?api-version=2018-01-01` +
      `&metricnames=${encodeURIComponent(descriptor.name)}` +
      `&timespan=${encodeURIComponent(timespan)}` +
      "&interval=PT5M&aggregation=Average,Total,Maximum,Minimum,Count";
    try {
      const response = await ctx.get<AzureMetricsResponse>(url);
      const metricSeries = mapMetricResponse(response, descriptor);
      if (metricSeries) series.push(metricSeries);
    } catch {
      // Azure Monitor returns 400 for unsupported metric names on a resource.
      // Keep the tab useful by showing every metric that does exist.
    }
  }

  return series;
}

function mapMetricResponse(
  response: AzureMetricsResponse,
  descriptor: MetricDescriptor,
): MetricSeries | null {
  const metric = response.value?.[0];
  const points =
    metric?.timeseries
      ?.flatMap((ts) => ts.data ?? [])
      .map((point) => {
        const timestamp = Date.parse(String(point.timeStamp ?? ""));
        const value = firstNumber(
          point.average,
          point.total,
          point.maximum,
          point.minimum,
          point.count,
        );
        return Number.isFinite(timestamp) && value !== undefined ? { timestamp, value } : null;
      })
      .filter((point): point is { timestamp: number; value: number } => point !== null) ?? [];
  if (!points.length) return null;

  return {
    label: metric?.name?.localizedValue ?? metric?.name?.value ?? descriptor.label,
    ...(metric?.unit ? { unit: metric.unit } : {}),
    points,
  };
}

function firstNumber(...values: Array<number | undefined>): number | undefined {
  return values.find((value) => typeof value === "number" && Number.isFinite(value));
}

function buildAzureResourceId(
  ctx: AzureHttpContext,
  resourceTypeId: string,
  resource: ResourceInstance,
): string {
  const outputId = String(resource.resolvedOutputs?.["resourceId"] ?? "");
  if (outputId.startsWith("/subscriptions/")) return outputId;
  const externalId = String(resource.externalId ?? "").trim();
  if (externalId.startsWith("/subscriptions/")) return externalId;

  if (resourceTypeId === "azure-sql-database") {
    const [resourceGroup, serverName, databaseName] = externalId.split("/");
    if (!resourceGroup || !serverName || !databaseName) return "";
    return `/subscriptions/${ctx.subscriptionId}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Sql/servers/${encodeURIComponent(serverName)}/databases/${encodeURIComponent(databaseName)}`;
  }

  const spec = AZURE_ARM_SPECS[resourceTypeId];
  const resourceGroup = String(resource.fields["resourceGroup"] ?? externalId.split("/")[0] ?? "");
  const name = String(resource.fields["name"] ?? externalId.split("/").at(-1) ?? "");
  if (!spec?.provider || !resourceGroup || !name) return "";

  return `/subscriptions/${ctx.subscriptionId}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/${spec.provider}/${encodeURIComponent(name)}`;
}
