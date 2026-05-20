import type { MetricSeries, ResourceInstance } from "@infrawrench/plugin-base";
import type { MetricsContext } from "./cw-helpers.js";

/**
 * Compute metric handlers — EC2, Auto Scaling, Lambda, EBS, ECS, App Runner.
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
  // Note: DiskRead/WriteOps are instance store (ephemeral) — for EBS use
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
  // IteratorAge applies only to stream sources (Kinesis/DynamoDB/DocDB);
  // DeadLetterErrors / AsyncEventAge apply to async invocations; the
  // points-length guard naturally hides metrics that don't apply.
  const f = resource.fields;
  const fnName = String(f.name ?? resource.externalId ?? "");
  if (!fnName) return [];
  const dims = [{ Name: "FunctionName", Value: fnName }];
  const [
    invocations,
    duration,
    errors,
    throttles,
    concurrent,
    deadLetter,
    iteratorAge,
    asyncEventAge,
  ] = await Promise.all([
    ctx.fetchCw("AWS/Lambda", "Invocations", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/Lambda", "Duration", dims).catch(() => null),
    ctx.fetchCw("AWS/Lambda", "Errors", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/Lambda", "Throttles", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/Lambda", "ConcurrentExecutions", dims, "Maximum").catch(() => null),
    ctx.fetchCw("AWS/Lambda", "DeadLetterErrors", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/Lambda", "IteratorAge", dims, "Maximum").catch(() => null),
    ctx.fetchCw("AWS/Lambda", "AsyncEventAge", dims, "Maximum").catch(() => null),
  ]);
  const results: MetricSeries[] = [];
  if (invocations && invocations.points.length > 0)
    results.push({ ...invocations, label: "Invocations" });
  if (duration && duration.points.length > 0)
    results.push({ ...duration, label: "Duration", unit: "ms" });
  if (errors && errors.points.length > 0) results.push({ ...errors, label: "Errors" });
  if (throttles && throttles.points.length > 0) results.push({ ...throttles, label: "Throttles" });
  if (concurrent && concurrent.points.length > 0)
    results.push({ ...concurrent, label: "Concurrent Executions" });
  if (deadLetter && deadLetter.points.length > 0)
    results.push({ ...deadLetter, label: "Dead Letter Errors" });
  if (iteratorAge && iteratorAge.points.length > 0)
    results.push({ ...iteratorAge, label: "Iterator Age", unit: "ms" });
  if (asyncEventAge && asyncEventAge.points.length > 0)
    results.push({ ...asyncEventAge, label: "Async Event Age", unit: "ms" });
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
  const f = resource.fields;
  const clusterName = String(f.clusterName ?? "");
  const serviceName = String(f.serviceName ?? resource.externalId ?? "");
  if (!clusterName || !serviceName) return [];
  const dims = [
    { Name: "ClusterName", Value: clusterName },
    { Name: "ServiceName", Value: serviceName },
  ];
  const [cpu, mem] = await Promise.all([
    ctx.fetchCw("AWS/ECS", "CPUUtilization", dims).catch(() => null),
    ctx.fetchCw("AWS/ECS", "MemoryUtilization", dims).catch(() => null),
  ]);
  const results: MetricSeries[] = [];
  if (cpu && cpu.points.length > 0) results.push({ ...cpu, label: "CPU Utilization", unit: "%" });
  if (mem && mem.points.length > 0)
    results.push({ ...mem, label: "Memory Utilization", unit: "%" });
  return results;
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
