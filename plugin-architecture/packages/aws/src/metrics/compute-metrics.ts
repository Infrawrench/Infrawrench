import type { MetricSeries, ResourceInstance } from "@infrawrench/plugin-base";
import type { MetricsContext } from "./cw-helpers.js";

/**
 * Compute metric handlers: EC2, Auto Scaling, Lambda, EBS, ECS, App Runner, EKS.
 *
 * Each handler returns the per-service series we surface in the dashboard /
 * resource detail. Empty series (no datapoints in the window) are filtered
 * out by the caller.
 */

export async function ec2InstanceMetrics(
  ctx: MetricsContext,
  resource: ResourceInstance,
): Promise<MetricSeries[]> {
  // Verified against
  // https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/viewing_metrics_with_cloudwatch.html
  // Note: DiskRead/WriteOps are instance store (ephemeral), for EBS use
  // EBSReadOps/EBSWriteOps. CPUCreditBalance is T-class only and silently
  // returns empty for other instance types.
  const instanceId = resource.externalId ?? "";
  const dims = [{ Name: "InstanceId", Value: instanceId }];
  const [
    cpu,
    netIn,
    netOut,
    netPktsIn,
    netPktsOut,
    statusFailed,
    statusInst,
    statusSys,
    diskRead,
    diskWrite,
    ebsReadBytes,
    ebsWriteBytes,
    ebsReadOps,
    ebsWriteOps,
    creditBalance,
  ] = await Promise.all([
    ctx.fetchCw("AWS/EC2", "CPUUtilization", dims).catch(() => null),
    ctx.fetchCw("AWS/EC2", "NetworkIn", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/EC2", "NetworkOut", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/EC2", "NetworkPacketsIn", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/EC2", "NetworkPacketsOut", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/EC2", "StatusCheckFailed", dims, "Maximum").catch(() => null),
    ctx.fetchCw("AWS/EC2", "StatusCheckFailed_Instance", dims, "Maximum").catch(() => null),
    ctx.fetchCw("AWS/EC2", "StatusCheckFailed_System", dims, "Maximum").catch(() => null),
    ctx.fetchCw("AWS/EC2", "DiskReadOps", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/EC2", "DiskWriteOps", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/EC2", "EBSReadBytes", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/EC2", "EBSWriteBytes", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/EC2", "EBSReadOps", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/EC2", "EBSWriteOps", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/EC2", "CPUCreditBalance", dims).catch(() => null),
  ]);
  const results: MetricSeries[] = [];
  if (cpu && cpu.points.length > 0) results.push({ ...cpu, unit: "%" });
  if (netIn && netIn.points.length > 0)
    results.push({ ...netIn, label: "Network In", unit: "bytes" });
  if (netOut && netOut.points.length > 0)
    results.push({ ...netOut, label: "Network Out", unit: "bytes" });
  if (netPktsIn && netPktsIn.points.length > 0) results.push({ ...netPktsIn, label: "Packets In" });
  if (netPktsOut && netPktsOut.points.length > 0)
    results.push({ ...netPktsOut, label: "Packets Out" });
  if (statusFailed && statusFailed.points.length > 0)
    results.push({ ...statusFailed, label: "Status Check Failed" });
  if (statusInst && statusInst.points.length > 0)
    results.push({ ...statusInst, label: "Instance Check Failed" });
  if (statusSys && statusSys.points.length > 0)
    results.push({ ...statusSys, label: "System Check Failed" });
  if (ebsReadBytes && ebsReadBytes.points.length > 0)
    results.push({ ...ebsReadBytes, label: "EBS Read", unit: "bytes" });
  if (ebsWriteBytes && ebsWriteBytes.points.length > 0)
    results.push({ ...ebsWriteBytes, label: "EBS Write", unit: "bytes" });
  if (ebsReadOps && ebsReadOps.points.length > 0)
    results.push({ ...ebsReadOps, label: "EBS Read Ops" });
  if (ebsWriteOps && ebsWriteOps.points.length > 0)
    results.push({ ...ebsWriteOps, label: "EBS Write Ops" });
  if (diskRead && diskRead.points.length > 0)
    results.push({ ...diskRead, label: "Instance Store Read Ops" });
  if (diskWrite && diskWrite.points.length > 0)
    results.push({ ...diskWrite, label: "Instance Store Write Ops" });
  if (creditBalance && creditBalance.points.length > 0)
    results.push({ ...creditBalance, label: "CPU Credit Balance" });
  return results;
}

export async function lambdaFunctionMetrics(
  ctx: MetricsContext,
  resource: ResourceInstance,
): Promise<MetricSeries[]> {
  // Verified against
  // https://docs.aws.amazon.com/lambda/latest/dg/monitoring-metrics-types.html
  // IteratorAge applies only to stream sources (Kinesis/DynamoDB/DocDB),
  // OffsetLag only to Kafka sources; DeadLetterErrors, DestinationDelivery-
  // Failures and the AsyncEvents* family apply to async invocations;
  // RecursiveInvocationsDropped only appears when loop detection fires. The
  // points-length guard naturally hides metrics that don't apply.
  const f = resource.fields;
  const fnName = String(f.name ?? resource.externalId ?? "");
  if (!fnName) return [];
  const dims = [{ Name: "FunctionName", Value: fnName }];
  const specs: Array<{ metric: string; stat: string; label: string; unit?: string }> = [
    { metric: "Invocations", stat: "Sum", label: "Invocations" },
    { metric: "Duration", stat: "Average", label: "Duration", unit: "ms" },
    { metric: "Errors", stat: "Sum", label: "Errors" },
    { metric: "Throttles", stat: "Sum", label: "Throttles" },
    { metric: "ConcurrentExecutions", stat: "Maximum", label: "Concurrent Executions" },
    {
      metric: "ProvisionedConcurrencySpilloverInvocations",
      stat: "Sum",
      label: "Provisioned Concurrency Spillover",
    },
    {
      metric: "PostRuntimeExtensionsDuration",
      stat: "Average",
      label: "Extensions Duration",
      unit: "ms",
    },
    { metric: "DeadLetterErrors", stat: "Sum", label: "Dead Letter Errors" },
    { metric: "DestinationDeliveryFailures", stat: "Sum", label: "Destination Delivery Failures" },
    { metric: "AsyncEventsReceived", stat: "Sum", label: "Async Events Received" },
    { metric: "AsyncEventAge", stat: "Maximum", label: "Async Event Age", unit: "ms" },
    { metric: "AsyncEventsDropped", stat: "Sum", label: "Async Events Dropped" },
    { metric: "IteratorAge", stat: "Maximum", label: "Iterator Age", unit: "ms" },
    { metric: "OffsetLag", stat: "Maximum", label: "Kafka Offset Lag" },
    { metric: "RecursiveInvocationsDropped", stat: "Sum", label: "Recursive Invocations Dropped" },
  ];
  return fetchSpecs(ctx, "AWS/Lambda", dims, specs);
}

/**
 * Fetch a table of `{ metric, stat, label, unit }` specs in parallel and keep
 * the non-empty series in table order. A failed call drops its series rather
 * than the whole tab.
 */
export async function fetchSpecs(
  ctx: MetricsContext,
  namespace: string,
  dims: Array<{ Name: string; Value: string }>,
  specs: Array<{ metric: string; stat: string; label: string; unit?: string }>,
): Promise<MetricSeries[]> {
  const series = await Promise.all(
    specs.map((s) => ctx.fetchCw(namespace, s.metric, dims, s.stat).catch(() => null)),
  );
  const results: MetricSeries[] = [];
  series.forEach((m, i) => {
    const spec = specs[i]!;
    if (m && m.points.length > 0) {
      results.push({ ...m, label: spec.label, ...(spec.unit ? { unit: spec.unit } : {}) });
    }
  });
  return results;
}

export async function autoScalingGroupMetrics(
  ctx: MetricsContext,
  resource: ResourceInstance,
): Promise<MetricSeries[]> {
  const f = resource.fields;
  const asgName = String(f.name ?? resource.externalId ?? "");
  if (!asgName) return [];
  const dims = [{ Name: "AutoScalingGroupName", Value: asgName }];
  const [inService, desired, total] = await Promise.all([
    ctx.fetchCw("AWS/AutoScaling", "GroupInServiceInstances", dims).catch(() => null),
    ctx.fetchCw("AWS/AutoScaling", "GroupDesiredCapacity", dims).catch(() => null),
    ctx.fetchCw("AWS/AutoScaling", "GroupTotalInstances", dims).catch(() => null),
  ]);
  const results: MetricSeries[] = [];
  if (inService && inService.points.length > 0)
    results.push({ ...inService, label: "In-Service Instances" });
  if (desired && desired.points.length > 0) results.push({ ...desired, label: "Desired Capacity" });
  if (total && total.points.length > 0) results.push({ ...total, label: "Total Instances" });
  return results;
}

export async function ebsVolumeMetrics(
  ctx: MetricsContext,
  resource: ResourceInstance,
): Promise<MetricSeries[]> {
  // EBS dimension is the volume id (`vol-...`), which matches externalId.
  const f = resource.fields;
  const volumeId = String(f.volumeId ?? resource.externalId ?? "");
  if (!volumeId) return [];
  const dims = [{ Name: "VolumeId", Value: volumeId }];
  const [readBytes, writeBytes, readOps, writeOps, queueLen] = await Promise.all([
    ctx.fetchCw("AWS/EBS", "VolumeReadBytes", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/EBS", "VolumeWriteBytes", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/EBS", "VolumeReadOps", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/EBS", "VolumeWriteOps", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/EBS", "VolumeQueueLength", dims).catch(() => null),
  ]);
  const results: MetricSeries[] = [];
  if (readBytes && readBytes.points.length > 0)
    results.push({ ...readBytes, label: "Read Bytes", unit: "bytes" });
  if (writeBytes && writeBytes.points.length > 0)
    results.push({ ...writeBytes, label: "Write Bytes", unit: "bytes" });
  if (readOps && readOps.points.length > 0) results.push({ ...readOps, label: "Read Ops" });
  if (writeOps && writeOps.points.length > 0) results.push({ ...writeOps, label: "Write Ops" });
  if (queueLen && queueLen.points.length > 0) results.push({ ...queueLen, label: "Queue Length" });
  return results;
}

export async function ecsServiceMetrics(
  ctx: MetricsContext,
  resource: ResourceInstance,
): Promise<MetricSeries[]> {
  // `AWS/ECS` CPU/memory utilization is always published. The task counts,
  // network and storage series live in `ECS/ContainerInsights` and only exist
  // once Container Insights is turned on for the cluster; until then they
  // come back empty and the points-length guard hides them. Verified against
  // https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Container-Insights-metrics-ECS.html
  const f = resource.fields;
  const clusterName = String(f.clusterName ?? "");
  const serviceName = String(f.serviceName ?? resource.externalId ?? "");
  if (!clusterName || !serviceName) return [];
  const dims = [
    { Name: "ClusterName", Value: clusterName },
    { Name: "ServiceName", Value: serviceName },
  ];
  const [vended, insights] = await Promise.all([
    fetchSpecs(ctx, "AWS/ECS", dims, [
      { metric: "CPUUtilization", stat: "Average", label: "CPU Utilization", unit: "%" },
      { metric: "MemoryUtilization", stat: "Average", label: "Memory Utilization", unit: "%" },
    ]),
    fetchSpecs(ctx, "ECS/ContainerInsights", dims, [
      { metric: "RunningTaskCount", stat: "Average", label: "Running Tasks" },
      { metric: "DesiredTaskCount", stat: "Average", label: "Desired Tasks" },
      { metric: "PendingTaskCount", stat: "Average", label: "Pending Tasks" },
      { metric: "DeploymentCount", stat: "Maximum", label: "Deployments" },
      { metric: "RestartCount", stat: "Sum", label: "Container Restarts" },
      { metric: "NetworkRxBytes", stat: "Average", label: "Network In", unit: "bytes/s" },
      { metric: "NetworkTxBytes", stat: "Average", label: "Network Out", unit: "bytes/s" },
      { metric: "StorageReadBytes", stat: "Average", label: "Storage Read", unit: "bytes" },
      { metric: "StorageWriteBytes", stat: "Average", label: "Storage Write", unit: "bytes" },
    ]),
  ]);
  return [...vended, ...insights];
}

export async function appRunnerServiceMetrics(
  ctx: MetricsContext,
  resource: ResourceInstance,
): Promise<MetricSeries[]> {
  // App Runner dim is ServiceName. Service-level metrics include the
  // request/response counters; instance-level metrics are CPU/Memory.
  // Verified against
  // https://docs.aws.amazon.com/apprunner/latest/dg/monitor-cw.html
  const f = resource.fields;
  const serviceName = String(f.serviceName ?? resource.externalId ?? "");
  if (!serviceName) return [];
  const dims = [{ Name: "ServiceName", Value: serviceName }];
  const [cpu, mem, reqs, latency, concurrency, activeInstances, status4xx, status5xx] =
    await Promise.all([
      ctx.fetchCw("AWS/AppRunner", "CPUUtilization", dims).catch(() => null),
      ctx.fetchCw("AWS/AppRunner", "MemoryUtilization", dims).catch(() => null),
      ctx.fetchCw("AWS/AppRunner", "Requests", dims, "Sum").catch(() => null),
      ctx.fetchCw("AWS/AppRunner", "RequestLatency", dims).catch(() => null),
      ctx.fetchCw("AWS/AppRunner", "Concurrency", dims).catch(() => null),
      ctx.fetchCw("AWS/AppRunner", "ActiveInstances", dims).catch(() => null),
      ctx.fetchCw("AWS/AppRunner", "4xxStatusResponses", dims, "Sum").catch(() => null),
      ctx.fetchCw("AWS/AppRunner", "5xxStatusResponses", dims, "Sum").catch(() => null),
    ]);
  const results: MetricSeries[] = [];
  if (cpu && cpu.points.length > 0) results.push({ ...cpu, label: "CPU Utilization", unit: "%" });
  if (mem && mem.points.length > 0)
    results.push({ ...mem, label: "Memory Utilization", unit: "%" });
  if (reqs && reqs.points.length > 0) results.push({ ...reqs, label: "Requests" });
  if (latency && latency.points.length > 0)
    results.push({ ...latency, label: "Request Latency", unit: "ms" });
  if (concurrency && concurrency.points.length > 0)
    results.push({ ...concurrency, label: "Concurrency" });
  if (activeInstances && activeInstances.points.length > 0)
    results.push({ ...activeInstances, label: "Active Instances" });
  if (status4xx && status4xx.points.length > 0)
    results.push({ ...status4xx, label: "4xx Responses" });
  if (status5xx && status5xx.points.length > 0)
    results.push({ ...status5xx, label: "5xx Responses" });
  return results;
}

export async function eksClusterMetrics(
  ctx: MetricsContext,
  resource: ResourceInstance,
): Promise<MetricSeries[]> {
  // Control plane metrics EKS vends to `AWS/EKS` for free on Kubernetes 1.28+,
  // one datapoint a minute per cluster. Verified against
  // https://docs.aws.amazon.com/eks/latest/userguide/cloudwatch.html
  // Counters use Sum as documented. Gauges (pending pods, in-flight requests,
  // etcd size) use Maximum so a window wider than a minute reports the peak
  // instead of adding the per-minute samples together. The latency series are
  // already p99 values computed by EKS, so Average is the documented stat.
  const clusterName = String(resource.fields.name ?? resource.externalId ?? "");
  if (!clusterName) return [];
  const dims = [{ Name: "ClusterName", Value: clusterName }];
  return fetchSpecs(ctx, "AWS/EKS", dims, [
    { metric: "apiserver_request_total", stat: "Sum", label: "API Requests" },
    { metric: "apiserver_request_total_4XX", stat: "Sum", label: "API 4xx Responses" },
    { metric: "apiserver_request_total_5XX", stat: "Sum", label: "API 5xx Responses" },
    { metric: "apiserver_request_total_429", stat: "Sum", label: "API Throttled (429)" },
    {
      metric: "apiserver_request_duration_seconds_GET_P99",
      stat: "Average",
      label: "GET Latency p99",
      unit: "s",
    },
    {
      metric: "apiserver_request_duration_seconds_LIST_P99",
      stat: "Average",
      label: "LIST Latency p99",
      unit: "s",
    },
    {
      metric: "apiserver_request_duration_seconds_POST_P99",
      stat: "Average",
      label: "POST Latency p99",
      unit: "s",
    },
    {
      metric: "apiserver_request_duration_seconds_PUT_P99",
      stat: "Average",
      label: "PUT Latency p99",
      unit: "s",
    },
    {
      metric: "apiserver_request_duration_seconds_PATCH_P99",
      stat: "Average",
      label: "PATCH Latency p99",
      unit: "s",
    },
    {
      metric: "apiserver_request_duration_seconds_DELETE_P99",
      stat: "Average",
      label: "DELETE Latency p99",
      unit: "s",
    },
    {
      metric: "apiserver_current_inflight_requests_READONLY",
      stat: "Maximum",
      label: "In-flight Read Requests",
    },
    {
      metric: "apiserver_current_inflight_requests_MUTATING",
      stat: "Maximum",
      label: "In-flight Mutating Requests",
    },
    {
      metric: "apiserver_flowcontrol_current_executing_seats",
      stat: "Maximum",
      label: "Executing Seats (APF)",
    },
    { metric: "scheduler_pending_pods", stat: "Maximum", label: "Pending Pods" },
    {
      metric: "scheduler_pending_pods_UNSCHEDULABLE",
      stat: "Maximum",
      label: "Unschedulable Pods",
    },
    {
      metric: "scheduler_schedule_attempts_SCHEDULED",
      stat: "Sum",
      label: "Scheduling Attempts: Scheduled",
    },
    {
      metric: "scheduler_schedule_attempts_UNSCHEDULABLE",
      stat: "Sum",
      label: "Scheduling Attempts: Unschedulable",
    },
    {
      metric: "scheduler_schedule_attempts_ERROR",
      stat: "Sum",
      label: "Scheduling Attempts: Error",
    },
    {
      metric: "apiserver_admission_webhook_rejection_count",
      stat: "Sum",
      label: "Admission Webhook Rejections",
    },
    {
      metric: "apiserver_admission_webhook_admission_duration_seconds",
      stat: "Average",
      label: "Admission Webhook Latency p99",
      unit: "s",
    },
    {
      metric: "etcd_mvcc_db_total_size_in_use_in_bytes",
      stat: "Maximum",
      label: "etcd Size In Use",
      unit: "bytes",
    },
    {
      metric: "etcd_mvcc_db_total_size_in_bytes",
      stat: "Maximum",
      label: "etcd Size Allocated",
      unit: "bytes",
    },
  ]);
}
