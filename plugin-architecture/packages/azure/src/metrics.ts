import type { MetricSeries, ResourceInstance } from "@infrawrench/plugin-base";
import { ARM, AZURE_ARM_SPECS, type AzureHttpContext } from "./shared.js";

/**
 * Azure Monitor aggregation a descriptor reads. Each metric's docs list a
 * default ("Total (Sum)" for counters, "Count" for a few request counters,
 * "Average" for gauges); asking for only that one keeps a 5-minute bucket of
 * HTTP 5xx reading as "how many", not "average per sample".
 */
type Aggregation = "Average" | "Total" | "Maximum" | "Count";

interface MetricDescriptor {
  name: string;
  label: string;
  /** Omitted → request every aggregation and plot the first one present. */
  agg?: Aggregation;
}

const TOTAL = "Total" as const;
const COUNT = "Count" as const;
const MAX = "Maximum" as const;

// Names are the "Name in REST API" column of
// https://learn.microsoft.com/azure/azure-monitor/reference/supported-metrics/
// (one page per resource provider). A name the resource doesn't emit (SKU,
// tier or kind specific) comes back 400 or empty and is dropped.
const METRICS_BY_TYPE: Record<string, MetricDescriptor[]> = {
  "azure-vm": [
    { name: "Percentage CPU", label: "CPU" },
    { name: "Available Memory Bytes", label: "Available memory" },
    { name: "Available Memory Percentage", label: "Available memory %" },
    { name: "CPU Credits Remaining", label: "CPU credits remaining" },
    { name: "Disk Read Bytes", label: "Disk read", agg: TOTAL },
    { name: "Disk Write Bytes", label: "Disk write", agg: TOTAL },
    { name: "Disk Read Operations/Sec", label: "Disk read ops/sec" },
    { name: "Disk Write Operations/Sec", label: "Disk write ops/sec" },
    { name: "OS Disk IOPS Consumed Percentage", label: "OS disk IOPS consumed" },
    { name: "OS Disk Bandwidth Consumed Percentage", label: "OS disk bandwidth consumed" },
    { name: "OS Disk Latency", label: "OS disk latency" },
    { name: "Data Disk Latency", label: "Data disk latency" },
    { name: "VM Cached IOPS Consumed Percentage", label: "Cached IOPS consumed" },
    { name: "VM Uncached IOPS Consumed Percentage", label: "Uncached IOPS consumed" },
    { name: "Network In Total", label: "Network in", agg: TOTAL },
    { name: "Network Out Total", label: "Network out", agg: TOTAL },
    { name: "Inbound Flows", label: "Inbound flows" },
    { name: "Outbound Flows", label: "Outbound flows" },
    { name: "VmAvailabilityMetric", label: "Availability" },
  ],
  "azure-disk": [
    { name: "Composite Disk Read Bytes/sec", label: "Read bytes/sec" },
    { name: "Composite Disk Write Bytes/sec", label: "Write bytes/sec" },
    { name: "Composite Disk Read Operations/sec", label: "Read ops/sec" },
    { name: "Composite Disk Write Operations/sec", label: "Write ops/sec" },
    { name: "DiskPaidBurstIOPS", label: "Paid burst IOPS" },
  ],
  "azure-aks-cluster": [
    { name: "node_cpu_usage_percentage", label: "Node CPU" },
    { name: "node_memory_working_set_percentage", label: "Node memory" },
    { name: "node_disk_usage_percentage", label: "Node disk" },
    { name: "node_network_in_bytes", label: "Node network in" },
    { name: "node_network_out_bytes", label: "Node network out" },
    { name: "kube_pod_status_ready", label: "Ready pods", agg: TOTAL },
    { name: "kube_node_status_condition", label: "Node conditions", agg: TOTAL },
    { name: "cluster_autoscaler_unschedulable_pods_count", label: "Unschedulable pods" },
    // Control-plane metrics: API server and etcd load, as AKS reports them.
    { name: "apiserver_cpu_usage_percentage", label: "API server CPU", agg: MAX },
    { name: "apiserver_memory_usage_percentage", label: "API server memory", agg: MAX },
    { name: "apiserver_current_inflight_requests", label: "API server inflight requests" },
    { name: "etcd_database_usage_percentage", label: "etcd database usage", agg: MAX },
  ],
  "azure-sql-database": [
    { name: "cpu_percent", label: "CPU" },
    { name: "dtu_consumption_percent", label: "DTU" },
    { name: "app_cpu_percent", label: "App CPU" },
    { name: "app_memory_percent", label: "App memory" },
    { name: "physical_data_read_percent", label: "Data IO" },
    { name: "log_write_percent", label: "Log IO" },
    { name: "storage_percent", label: "Storage" },
    { name: "workers_percent", label: "Workers" },
    { name: "sessions_percent", label: "Sessions" },
    { name: "connection_successful", label: "Successful connections", agg: TOTAL },
    { name: "connection_failed", label: "Failed connections", agg: TOTAL },
    { name: "blocked_by_firewall", label: "Blocked by firewall", agg: TOTAL },
    { name: "deadlock", label: "Deadlocks", agg: TOTAL },
    { name: "availability", label: "Availability" },
  ],
  "azure-cosmos-db": [
    { name: "TotalRequests", label: "Requests", agg: COUNT },
    { name: "TotalRequestUnits", label: "Request units", agg: TOTAL },
    { name: "NormalizedRUConsumption", label: "Normalized RU consumption", agg: MAX },
    { name: "ThrottledRequestPercentage", label: "Throttled requests" },
    { name: "ServerSideLatency", label: "Server-side latency" },
    { name: "ServiceAvailability", label: "Availability" },
    { name: "ProvisionedThroughput", label: "Provisioned throughput", agg: MAX },
    { name: "AutoscaledRU", label: "Autoscaled RU", agg: MAX },
    { name: "DataUsage", label: "Data usage" },
    { name: "IndexUsage", label: "Index usage" },
    { name: "DocumentCount", label: "Documents" },
  ],
  "azure-storage-account": [
    { name: "UsedCapacity", label: "Used capacity" },
    { name: "Transactions", label: "Transactions", agg: TOTAL },
    { name: "Ingress", label: "Ingress", agg: TOTAL },
    { name: "Egress", label: "Egress", agg: TOTAL },
    { name: "SuccessE2ELatency", label: "E2E latency" },
    { name: "SuccessServerLatency", label: "Server latency" },
    { name: "Availability", label: "Availability" },
  ],
  "azure-function-app": [
    { name: "FunctionExecutionCount", label: "Executions", agg: TOTAL },
    { name: "FunctionExecutionUnits", label: "Execution units", agg: TOTAL },
    // Flex Consumption splits executions by billing meter.
    { name: "OnDemandFunctionExecutionCount", label: "On-demand executions", agg: TOTAL },
    { name: "AlwaysReadyFunctionExecutionCount", label: "Always-ready executions", agg: TOTAL },
    { name: "CpuTime", label: "CPU time", agg: TOTAL },
    { name: "Requests", label: "Requests", agg: TOTAL },
    { name: "Http4xx", label: "HTTP 4xx", agg: TOTAL },
    { name: "Http5xx", label: "HTTP 5xx", agg: TOTAL },
    { name: "HttpResponseTime", label: "Response time" },
    { name: "AverageMemoryWorkingSet", label: "Memory working set" },
    { name: "InstanceCount", label: "Instances" },
  ],
  "azure-app-service": [
    { name: "CpuTime", label: "CPU time", agg: TOTAL },
    { name: "Requests", label: "Requests", agg: TOTAL },
    { name: "HttpResponseTime", label: "Response time" },
    { name: "AverageMemoryWorkingSet", label: "Memory working set" },
    { name: "Http2xx", label: "HTTP 2xx", agg: TOTAL },
    { name: "Http4xx", label: "HTTP 4xx", agg: TOTAL },
    { name: "Http5xx", label: "HTTP 5xx", agg: TOTAL },
    { name: "BytesReceived", label: "Data in", agg: TOTAL },
    { name: "BytesSent", label: "Data out", agg: TOTAL },
    { name: "HealthCheckStatus", label: "Health check status" },
    { name: "RequestsInApplicationQueue", label: "Requests in queue" },
    { name: "AppConnections", label: "Connections" },
    { name: "InstanceCount", label: "Instances" },
    { name: "FileSystemUsage", label: "File system usage" },
  ],
  "azure-app-service-plan": [
    { name: "CpuPercentage", label: "CPU" },
    { name: "MemoryPercentage", label: "Memory" },
    { name: "DiskQueueLength", label: "Disk queue length" },
    { name: "HttpQueueLength", label: "HTTP queue length" },
    { name: "BytesReceived", label: "Data in", agg: TOTAL },
    { name: "BytesSent", label: "Data out", agg: TOTAL },
    { name: "TcpEstablished", label: "TCP established" },
    { name: "SocketOutboundAll", label: "Outbound sockets" },
  ],
  "azure-container-instance": [
    { name: "CpuUsage", label: "CPU" },
    { name: "MemoryUsage", label: "Memory" },
    { name: "NetworkBytesReceivedPerSecond", label: "Network received" },
    { name: "NetworkBytesTransmittedPerSecond", label: "Network transmitted" },
  ],
  "azure-key-vault": [
    { name: "ServiceApiHit", label: "API hits", agg: COUNT },
    { name: "ServiceApiResult", label: "API results", agg: COUNT },
    { name: "ServiceApiLatency", label: "API latency" },
    { name: "Availability", label: "Availability" },
    { name: "SaturationShoebox", label: "Saturation" },
  ],
  "azure-redis-cache": [
    { name: "percentProcessorTime", label: "CPU" },
    { name: "serverLoad", label: "Server load" },
    { name: "usedmemorypercentage", label: "Used memory %" },
    { name: "usedmemory", label: "Used memory" },
    { name: "operationsPerSecond", label: "Operations/sec", agg: MAX },
    { name: "cachehits", label: "Cache hits", agg: TOTAL },
    { name: "cachemisses", label: "Cache misses", agg: TOTAL },
    { name: "cachemissrate", label: "Cache miss rate" },
    { name: "cacheLatency", label: "Latency" },
    { name: "cacheRead", label: "Cache read", agg: MAX },
    { name: "cacheWrite", label: "Cache write", agg: MAX },
    { name: "connectedclients", label: "Connected clients", agg: MAX },
    { name: "evictedkeys", label: "Evicted keys", agg: TOTAL },
    { name: "totalkeys", label: "Total keys", agg: MAX },
    { name: "errors", label: "Errors", agg: MAX },
  ],
  "azure-service-bus": [
    { name: "IncomingMessages", label: "Incoming messages", agg: TOTAL },
    { name: "OutgoingMessages", label: "Outgoing messages", agg: TOTAL },
    { name: "ActiveMessages", label: "Active messages" },
    { name: "DeadletteredMessages", label: "Dead-lettered messages" },
    { name: "ScheduledMessages", label: "Scheduled messages" },
    { name: "IncomingRequests", label: "Requests", agg: TOTAL },
    { name: "ServerErrors", label: "Server errors", agg: TOTAL },
    { name: "UserErrors", label: "User errors", agg: TOTAL },
    { name: "ThrottledRequests", label: "Throttled requests", agg: TOTAL },
    { name: "ActiveConnections", label: "Connections", agg: TOTAL },
    { name: "ServerSendLatency", label: "Send latency" },
    { name: "NamespaceCpuUsage", label: "Namespace CPU", agg: MAX },
    { name: "NamespaceMemoryUsage", label: "Namespace memory", agg: MAX },
    { name: "Size", label: "Size" },
  ],
  "azure-event-hub": [
    { name: "IncomingMessages", label: "Incoming messages", agg: TOTAL },
    { name: "OutgoingMessages", label: "Outgoing messages", agg: TOTAL },
    { name: "IncomingBytes", label: "Incoming bytes", agg: TOTAL },
    { name: "OutgoingBytes", label: "Outgoing bytes", agg: TOTAL },
    { name: "IncomingRequests", label: "Requests", agg: TOTAL },
    { name: "ServerErrors", label: "Server errors", agg: TOTAL },
    { name: "UserErrors", label: "User errors", agg: TOTAL },
    { name: "ThrottledRequests", label: "Throttled requests", agg: TOTAL },
    { name: "QuotaExceededErrors", label: "Quota exceeded errors", agg: TOTAL },
    { name: "ActiveConnections", label: "Connections" },
    { name: "CapturedBytes", label: "Captured bytes", agg: TOTAL },
    { name: "CaptureBacklog", label: "Capture backlog", agg: TOTAL },
    { name: "NamespaceCpuUsage", label: "Namespace CPU", agg: MAX },
    { name: "Size", label: "Size" },
  ],
  "azure-container-registry": [
    { name: "StorageUsed", label: "Storage used" },
    { name: "TotalPullCount", label: "Pulls", agg: TOTAL },
    { name: "SuccessfulPullCount", label: "Successful pulls", agg: TOTAL },
    { name: "TotalPushCount", label: "Pushes", agg: TOTAL },
    { name: "SuccessfulPushCount", label: "Successful pushes", agg: TOTAL },
    { name: "DataTransfer", label: "Data transfer", agg: TOTAL },
    { name: "Transactions", label: "Transactions", agg: TOTAL },
    { name: "RunDuration", label: "Task run duration", agg: TOTAL },
  ],
  "azure-load-balancer": [
    { name: "DipAvailability", label: "Backend availability" },
    { name: "VipAvailability", label: "Frontend availability" },
    { name: "ByteCount", label: "Bytes", agg: TOTAL },
    { name: "PacketCount", label: "Packets", agg: TOTAL },
    { name: "SYNCount", label: "SYN count", agg: TOTAL },
    { name: "SnatConnectionCount", label: "SNAT connections", agg: TOTAL },
    { name: "AllocatedSnatPorts", label: "Allocated SNAT ports" },
    { name: "UsedSnatPorts", label: "Used SNAT ports" },
  ],
  "azure-app-gateway": [
    { name: "Throughput", label: "Throughput" },
    { name: "TotalRequests", label: "Requests", agg: TOTAL },
    { name: "FailedRequests", label: "Failed requests", agg: TOTAL },
    { name: "CurrentConnections", label: "Connections", agg: TOTAL },
    { name: "HealthyHostCount", label: "Healthy hosts" },
    { name: "UnhealthyHostCount", label: "Unhealthy hosts" },
    { name: "ApplicationGatewayTotalTime", label: "Total time" },
    { name: "BackendLastByteResponseTime", label: "Backend response time" },
    { name: "ClientRtt", label: "Client RTT" },
    { name: "BytesReceived", label: "Data in", agg: TOTAL },
    { name: "BytesSent", label: "Data out", agg: TOTAL },
    { name: "CapacityUnits", label: "Capacity units" },
    { name: "ComputeUnits", label: "Compute units" },
    { name: "CpuUtilization", label: "CPU" },
  ],
  "azure-nat-gateway": [
    { name: "DatapathAvailability", label: "Datapath availability" },
    { name: "SNATConnectionCount", label: "SNAT connections", agg: TOTAL },
    { name: "TotalConnectionCount", label: "Connections", agg: TOTAL },
    { name: "ByteCount", label: "Bytes", agg: TOTAL },
    { name: "PacketCount", label: "Packets", agg: TOTAL },
    { name: "PacketDropCount", label: "Dropped packets", agg: TOTAL },
  ],
  "azure-public-ip": [
    { name: "ByteCount", label: "Bytes", agg: TOTAL },
    { name: "PacketCount", label: "Packets", agg: TOTAL },
    { name: "SYNCount", label: "SYN count", agg: TOTAL },
    { name: "VipAvailability", label: "Availability" },
    { name: "IfUnderDDoSAttack", label: "Under DDoS attack", agg: MAX },
    { name: "PacketsDroppedDDoS", label: "Packets dropped (DDoS)", agg: MAX },
  ],
  "azure-postgres-flexible": [
    { name: "cpu_percent", label: "CPU" },
    { name: "memory_percent", label: "Memory" },
    { name: "storage_percent", label: "Storage" },
    { name: "storage_used", label: "Storage used" },
    { name: "active_connections", label: "Active connections" },
    { name: "connections_failed", label: "Failed connections", agg: TOTAL },
    { name: "iops", label: "IOPS" },
    { name: "read_iops", label: "Read IOPS" },
    { name: "write_iops", label: "Write IOPS" },
    { name: "disk_iops_consumed_percentage", label: "Disk IOPS consumed" },
    { name: "disk_queue_depth", label: "Disk queue depth" },
    { name: "network_bytes_ingress", label: "Network in", agg: TOTAL },
    { name: "network_bytes_egress", label: "Network out", agg: TOTAL },
    { name: "cpu_credits_remaining", label: "CPU credits remaining" },
    { name: "physical_replication_delay_in_seconds", label: "Replication lag", agg: MAX },
    { name: "maximum_used_transactionIDs", label: "Max used transaction IDs" },
    { name: "backup_storage_used", label: "Backup storage" },
  ],
  "azure-mysql-flexible": [
    { name: "cpu_percent", label: "CPU" },
    { name: "memory_percent", label: "Memory" },
    { name: "storage_percent", label: "Storage" },
    { name: "storage_used", label: "Storage used" },
    { name: "active_connections", label: "Active connections" },
    { name: "aborted_connections", label: "Aborted connections", agg: TOTAL },
    { name: "io_consumption_percent", label: "IO consumption" },
    { name: "Queries", label: "Queries", agg: TOTAL },
    { name: "Slow_queries", label: "Slow queries", agg: TOTAL },
    { name: "network_bytes_ingress", label: "Network in", agg: TOTAL },
    { name: "network_bytes_egress", label: "Network out", agg: TOTAL },
    { name: "replication_lag", label: "Replication lag", agg: MAX },
    { name: "cpu_credits_remaining", label: "CPU credits remaining" },
    { name: "backup_storage_used", label: "Backup storage" },
  ],
  "azure-firewall": [
    { name: "FirewallHealth", label: "Health" },
    { name: "Throughput", label: "Throughput" },
    { name: "ApplicationRuleHit", label: "Application rule hits", agg: TOTAL },
    { name: "NetworkRuleHit", label: "Network rule hits", agg: TOTAL },
    { name: "DataProcessed", label: "Data processed", agg: TOTAL },
    { name: "SNATPortUtilization", label: "SNAT port utilization", agg: MAX },
    { name: "FirewallLatencyPng", label: "Latency probe" },
    { name: "ObservedCapacity", label: "Observed capacity units" },
  ],
  "azure-dns-zone": [
    { name: "QueryVolume", label: "Query volume", agg: TOTAL },
    { name: "RecordSetCount", label: "Record sets", agg: MAX },
    { name: "RecordSetCapacityUtilization", label: "Record-set capacity", agg: MAX },
  ],
  "azure-private-dns-zone": [
    { name: "QueryVolume", label: "Query volume", agg: TOTAL },
    { name: "RecordSetCount", label: "Record sets", agg: MAX },
    { name: "RecordSetCapacityUtilization", label: "Record-set capacity", agg: MAX },
    { name: "VirtualNetworkLinkCount", label: "VNet links", agg: MAX },
    { name: "VirtualNetworkLinkCapacityUtilization", label: "VNet-link capacity", agg: MAX },
  ],
  // The workspace's own platform metrics carry spaces in their REST names.
  "azure-log-analytics": [
    { name: "Ingestion Volume", label: "Ingestion volume", agg: TOTAL },
    { name: "Ingestion Time", label: "Ingestion latency" },
    { name: "Query Count", label: "Queries", agg: COUNT },
    { name: "Query Failure Count", label: "Failed queries", agg: COUNT },
    { name: "AvailabilityRate_Query", label: "Query availability" },
  ],
  "azure-container-app": [
    { name: "CpuPercentage", label: "CPU" },
    { name: "MemoryPercentage", label: "Memory" },
    { name: "UsageNanoCores", label: "CPU usage" },
    { name: "WorkingSetBytes", label: "Memory working set" },
    { name: "Requests", label: "Requests", agg: TOTAL },
    { name: "ResponseTime", label: "Response time" },
    { name: "Replicas", label: "Replicas", agg: MAX },
    { name: "RestartCount", label: "Restarts", agg: MAX },
    { name: "RxBytes", label: "Network in", agg: TOTAL },
    { name: "TxBytes", label: "Network out", agg: TOTAL },
    { name: "ResiliencyRequestRetries", label: "Resiliency retries", agg: TOTAL },
    { name: "ResiliencyRequestTimeouts", label: "Resiliency timeouts", agg: TOTAL },
    { name: "GpuUtilizationPercentage", label: "GPU" },
    { name: "JvmMemoryTotalUsed", label: "JVM memory used" },
    { name: "JvmGcCount", label: "JVM GC count", agg: TOTAL },
  ],
  "azure-container-app-environment": [
    { name: "NodeCount", label: "Workload profile nodes", agg: MAX },
    { name: "IngressCpuPercentage", label: "Ingress CPU" },
    { name: "IngressMemoryPercentage", label: "Ingress memory" },
    { name: "IngressUsageBytes", label: "Ingress memory used" },
  ],
  "azure-container-app-job": [
    { name: "Executions", label: "Executions", agg: TOTAL },
    { name: "UsageNanoCores", label: "CPU usage" },
    { name: "UsageBytes", label: "Memory used" },
    { name: "RequestedCores", label: "Requested cores" },
    { name: "RequestedBytes", label: "Requested memory" },
    { name: "RestartCount", label: "Restarts", agg: MAX },
    { name: "RxBytes", label: "Network in", agg: TOTAL },
    { name: "TxBytes", label: "Network out", agg: TOTAL },
  ],
  "azure-managed-redis": [
    { name: "percentProcessorTime", label: "CPU" },
    { name: "serverLoad", label: "Server load" },
    { name: "usedmemorypercentage", label: "Used memory %" },
    { name: "usedmemory", label: "Used memory" },
    { name: "operationsPerSecond", label: "Operations/sec" },
    { name: "cachehits", label: "Cache hits" },
    { name: "cachemisses", label: "Cache misses" },
    { name: "cacheLatency", label: "Latency" },
    { name: "connectedclients", label: "Connected clients" },
    { name: "evictedkeys", label: "Evicted keys" },
    { name: "totalkeys", label: "Total keys" },
  ],
  // Azure OpenAI / Foundry model metrics first; the classic Cognitive
  // Services request counters cover the non-OpenAI kinds (Speech, Vision,
  // ...). Names a given account kind doesn't emit come back empty and are
  // dropped, so one list serves every kind.
  "azure-ai-services": [
    { name: "AzureOpenAIRequests", label: "Requests" },
    { name: "ProcessedPromptTokens", label: "Prompt tokens" },
    { name: "GeneratedTokens", label: "Completion tokens" },
    { name: "TokenTransaction", label: "Total tokens" },
    { name: "AzureOpenAITimeToResponse", label: "Time to response" },
    { name: "AzureOpenAIAvailabilityRate", label: "Availability" },
    { name: "AzureOpenAIProvisionedManagedUtilizationV2", label: "Provisioned utilization" },
    { name: "ModelRequests", label: "Model requests" },
    { name: "InputTokens", label: "Input tokens" },
    { name: "OutputTokens", label: "Output tokens" },
    { name: "TotalCalls", label: "Calls" },
    { name: "TotalErrors", label: "Errors" },
    { name: "Latency", label: "Latency" },
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

/** Concurrent Azure Monitor requests per Metrics tab load. */
const METRIC_FETCH_CONCURRENCY = 6;

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
  const interval = metricInterval(endMs - startMs);

  // One request per metric: a multi-name request fails as a whole when any
  // one name is unsupported on the resource, and most lists here carry names
  // only some SKUs emit.
  const fetchOne = async (descriptor: MetricDescriptor): Promise<MetricSeries | null> => {
    const url =
      `${ARM}${azureResourceId}/providers/Microsoft.Insights/metrics?api-version=2018-01-01` +
      `&metricnames=${encodeURIComponent(descriptor.name)}` +
      `&timespan=${encodeURIComponent(timespan)}` +
      `&interval=${interval}&aggregation=${descriptor.agg ?? "Average,Total,Maximum,Minimum,Count"}`;
    try {
      const response = await ctx.get<AzureMetricsResponse>(url);
      return mapMetricResponse(response, descriptor);
    } catch {
      // Azure Monitor returns 400 for unsupported metric names on a resource.
      // Keep the tab useful by showing every metric that does exist.
      return null;
    }
  };

  const results: Array<MetricSeries | null> = new Array(descriptors.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < descriptors.length) {
      const index = next++;
      results[index] = await fetchOne(descriptors[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(METRIC_FETCH_CONCURRENCY, descriptors.length) }, worker),
  );
  return results.filter((series): series is MetricSeries => series !== null);
}

/**
 * Bucket size for a window: 5-minute buckets up to six hours, coarser beyond
 * so a 30-day window stays a few hundred points. Every value is one of the
 * time grains Azure Monitor accepts for platform metrics.
 */
export function metricInterval(windowMs: number): string {
  const hours = windowMs / 3_600_000;
  if (hours <= 6) return "PT5M";
  if (hours <= 24) return "PT15M";
  if (hours <= 72) return "PT30M";
  if (hours <= 7 * 24) return "PT1H";
  return "PT6H";
}

/**
 * Azure Monitor unit names → the unit strings the host's charts format.
 * `bytes` / `bytes/s` get humanized axes; `Count` is dropped (a bare number
 * reads better than "42Count"); rates of non-byte things become "/s". Bits
 * and nanocores are rescaled so the chart reads in bytes and cores.
 */
const UNIT_MAP: Record<string, { unit: string; scale?: number }> = {
  bytes: { unit: "bytes" },
  bytespersecond: { unit: "bytes/s" },
  bitspersecond: { unit: "bytes/s", scale: 1 / 8 },
  percent: { unit: "%" },
  milliseconds: { unit: "ms" },
  seconds: { unit: "s" },
  count: { unit: "" },
  countpersecond: { unit: "/s" },
  nanocores: { unit: " cores", scale: 1e-9 },
  millicores: { unit: " cores", scale: 1e-3 },
  cores: { unit: " cores" },
  unspecified: { unit: "" },
};

export function normalizeAzureUnit(raw: string | undefined): { unit: string; scale: number } {
  const mapped = raw ? UNIT_MAP[raw.toLowerCase()] : undefined;
  if (!mapped) return { unit: raw ?? "", scale: 1 };
  return { unit: mapped.unit, scale: mapped.scale ?? 1 };
}

function mapMetricResponse(
  response: AzureMetricsResponse,
  descriptor: MetricDescriptor,
): MetricSeries | null {
  const metric = response.value?.[0];
  const { unit, scale } = normalizeAzureUnit(metric?.unit);
  const points =
    metric?.timeseries
      ?.flatMap((ts) => ts.data ?? [])
      .map((point) => {
        const timestamp = Date.parse(String(point.timeStamp ?? ""));
        const value = descriptor.agg
          ? firstNumber(point[AGG_FIELD[descriptor.agg]])
          : firstNumber(point.average, point.total, point.maximum, point.minimum, point.count);
        return Number.isFinite(timestamp) && value !== undefined
          ? { timestamp, value: value * scale }
          : null;
      })
      .filter((point): point is { timestamp: number; value: number } => point !== null) ?? [];
  if (!points.length) return null;

  return {
    label: metric?.name?.localizedValue ?? metric?.name?.value ?? descriptor.label,
    ...(unit ? { unit } : {}),
    points,
  };
}

const AGG_FIELD: Record<Aggregation, "average" | "total" | "maximum" | "count"> = {
  Average: "average",
  Total: "total",
  Maximum: "maximum",
  Count: "count",
};

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
