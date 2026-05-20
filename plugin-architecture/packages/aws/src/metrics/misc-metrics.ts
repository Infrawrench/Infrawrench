import type { MetricSeries, ResourceInstance } from "@infrawrench/plugin-base";
import type { MetricsContext } from "./cw-helpers.js";

/**
 * Smaller-service metric handlers: SageMaker endpoints, CodeBuild,
 * CloudWatch Log Groups, WAFv2.
 */

export async function sageMakerEndpointMetrics(
  ctx: MetricsContext,
  resource: ResourceInstance,
): Promise<MetricSeries[]> {
  // SageMaker requires both EndpointName and VariantName. Default variant is AllTraffic.
  // Verified against
  // https://docs.aws.amazon.com/sagemaker/latest/dg/monitoring-cloudwatch.html
  // (`AWS/SageMaker` namespace; latency metrics are in microseconds).
  const f = resource.fields;
  const endpointName = String(f.endpointName ?? resource.externalId ?? "");
  if (!endpointName) return [];
  const dims = [
    { Name: "EndpointName", Value: endpointName },
    { Name: "VariantName", Value: "AllTraffic" },
  ];
  const [invocations, modelLatency, overheadLatency, errors4xx, errors5xx] = await Promise.all([
    ctx.fetchCw("AWS/SageMaker", "Invocations", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/SageMaker", "ModelLatency", dims).catch(() => null),
    ctx.fetchCw("AWS/SageMaker", "OverheadLatency", dims).catch(() => null),
    ctx.fetchCw("AWS/SageMaker", "Invocation4XXErrors", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/SageMaker", "Invocation5XXErrors", dims, "Sum").catch(() => null),
  ]);
  const results: MetricSeries[] = [];
  if (invocations && invocations.points.length > 0)
    results.push({ ...invocations, label: "Invocations" });
  if (modelLatency && modelLatency.points.length > 0)
    results.push({ ...modelLatency, label: "Model Latency", unit: "μs" });
  if (overheadLatency && overheadLatency.points.length > 0)
    results.push({ ...overheadLatency, label: "Overhead Latency", unit: "μs" });
  if (errors4xx && errors4xx.points.length > 0) results.push({ ...errors4xx, label: "4xx Errors" });
  if (errors5xx && errors5xx.points.length > 0) results.push({ ...errors5xx, label: "5xx Errors" });
  return results;
}

export async function codeBuildProjectMetrics(
  ctx: MetricsContext,
  resource: ResourceInstance,
): Promise<MetricSeries[]> {
  const f = resource.fields;
  const projectName = String(f.name ?? resource.externalId ?? "");
  if (!projectName) return [];
  const dims = [{ Name: "ProjectName", Value: projectName }];
  const [builds, duration, succeeded, failed] = await Promise.all([
    ctx.fetchCw("AWS/CodeBuild", "Builds", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/CodeBuild", "Duration", dims).catch(() => null),
    ctx.fetchCw("AWS/CodeBuild", "SucceededBuilds", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/CodeBuild", "FailedBuilds", dims, "Sum").catch(() => null),
  ]);
  const results: MetricSeries[] = [];
  if (builds && builds.points.length > 0) results.push({ ...builds, label: "Builds" });
  if (duration && duration.points.length > 0)
    results.push({ ...duration, label: "Build Duration", unit: "s" });
  if (succeeded && succeeded.points.length > 0) results.push({ ...succeeded, label: "Succeeded" });
  if (failed && failed.points.length > 0) results.push({ ...failed, label: "Failed" });
  return results;
}

export async function cloudWatchLogGroupMetrics(
  ctx: MetricsContext,
  resource: ResourceInstance,
): Promise<MetricSeries[]> {
  // AWS/Logs dimension is LogGroupName, externalId is typically the name.
  const f = resource.fields;
  const logGroupName = String(f.logGroupName ?? resource.externalId ?? "");
  if (!logGroupName) return [];
  const dims = [{ Name: "LogGroupName", Value: logGroupName }];
  const [incomingBytes, incomingEvents] = await Promise.all([
    ctx.fetchCw("AWS/Logs", "IncomingBytes", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/Logs", "IncomingLogEvents", dims, "Sum").catch(() => null),
  ]);
  const results: MetricSeries[] = [];
  if (incomingBytes && incomingBytes.points.length > 0)
    results.push({ ...incomingBytes, label: "Incoming Bytes", unit: "bytes" });
  if (incomingEvents && incomingEvents.points.length > 0)
    results.push({ ...incomingEvents, label: "Incoming Log Events" });
  return results;
}

export async function wafWebAclMetrics(
  ctx: MetricsContext,
  resource: ResourceInstance,
): Promise<MetricSeries[]> {
  // WAFv2 requires WebACL + Rule (ALL) + Region. CloudFront-scoped uses Region "CloudFront".
  const f = resource.fields;
  const aclName = String(f.name ?? "");
  if (!aclName) return [];
  const scope = String(f.scope ?? "REGIONAL");
  const region = scope === "CLOUDFRONT" ? "CloudFront" : String(f.region ?? ctx.creds.region ?? "");
  const dims = [
    { Name: "WebACL", Value: aclName },
    { Name: "Rule", Value: "ALL" },
    { Name: "Region", Value: region },
  ];
  const [allowed, blocked, counted] = await Promise.all([
    ctx.fetchCw("AWS/WAFV2", "AllowedRequests", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/WAFV2", "BlockedRequests", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/WAFV2", "CountedRequests", dims, "Sum").catch(() => null),
  ]);
  const results: MetricSeries[] = [];
  if (allowed && allowed.points.length > 0) results.push({ ...allowed, label: "Allowed" });
  if (blocked && blocked.points.length > 0) results.push({ ...blocked, label: "Blocked" });
  if (counted && counted.points.length > 0) results.push({ ...counted, label: "Counted" });
  return results;
}
