import type { MetricSeries, ResourceInstance } from "@infrawrench/plugin-base";
import type { MetricsContext } from "./cw-helpers.js";

/**
 * Networking & edge metrics — ALB / target groups, CloudFront, API Gateway,
 * NAT Gateway, Route 53 health checks.
 */

export async function albMetrics(
  ctx: MetricsContext,
  resource: ResourceInstance,
): Promise<MetricSeries[]> {
  // Verified against
  // https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-cloudwatch-metrics.html
  // ALB dimension wants the trailing portion of the ARN (e.g.
  // `app/my-lb/abc123`). ELB 4xx/5xx are different from Target 4xx/5xx —
  // ELB-originated codes mean the load balancer never reached a target
  // (no targets, malformed request, etc.), so worth surfacing separately.
  const arn = String(resource.resolvedOutputs?.["loadBalancerArn"] ?? "");
  const dim = arn.split(":loadbalancer/").pop() ?? "";
  if (!dim) return [];
  const dims = [{ Name: "LoadBalancer", Value: dim }];
  const [
    reqs,
    active,
    newConn,
    rejected,
    bytes,
    latency,
    target5xx,
    target4xx,
    elb5xx,
    elb4xx,
    targetConnErr,
    consumedLcus,
  ] = await Promise.all([
    ctx.fetchCw("AWS/ApplicationELB", "RequestCount", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/ApplicationELB", "ActiveConnectionCount", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/ApplicationELB", "NewConnectionCount", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/ApplicationELB", "RejectedConnectionCount", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/ApplicationELB", "ProcessedBytes", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/ApplicationELB", "TargetResponseTime", dims).catch(() => null),
    ctx.fetchCw("AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/ApplicationELB", "HTTPCode_Target_4XX_Count", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/ApplicationELB", "HTTPCode_ELB_5XX_Count", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/ApplicationELB", "HTTPCode_ELB_4XX_Count", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/ApplicationELB", "TargetConnectionErrorCount", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/ApplicationELB", "ConsumedLCUs", dims).catch(() => null),
  ]);
  const results: MetricSeries[] = [];
  if (reqs && reqs.points.length > 0) results.push({ ...reqs, label: "Requests" });
  if (active && active.points.length > 0) results.push({ ...active, label: "Active Connections" });
  if (newConn && newConn.points.length > 0) results.push({ ...newConn, label: "New Connections" });
  if (rejected && rejected.points.length > 0)
    results.push({ ...rejected, label: "Rejected Connections" });
  if (bytes && bytes.points.length > 0)
    results.push({ ...bytes, label: "Processed Bytes", unit: "bytes" });
  if (latency && latency.points.length > 0)
    results.push({ ...latency, label: "Target Response Time", unit: "s" });
  if (target5xx && target5xx.points.length > 0)
    results.push({ ...target5xx, label: "5xx Errors (target)" });
  if (target4xx && target4xx.points.length > 0)
    results.push({ ...target4xx, label: "4xx Errors (target)" });
  if (elb5xx && elb5xx.points.length > 0) results.push({ ...elb5xx, label: "5xx Errors (ELB)" });
  if (elb4xx && elb4xx.points.length > 0) results.push({ ...elb4xx, label: "4xx Errors (ELB)" });
  if (targetConnErr && targetConnErr.points.length > 0)
    results.push({ ...targetConnErr, label: "Target Conn Errors" });
  if (consumedLcus && consumedLcus.points.length > 0)
    results.push({ ...consumedLcus, label: "Consumed LCUs" });
  return results;
}

export async function targetGroupMetrics(
  ctx: MetricsContext,
  resource: ResourceInstance,
): Promise<MetricSeries[]> {
  // Verified against
  // https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-cloudwatch-metrics.html
  // ALB target metrics REQUIRE both LoadBalancer and TargetGroup dims —
  // querying with just TargetGroup returns nothing. Both dims use the
  // trailing portion of the ARN (`app/...` and `targetgroup/...`).
  const f = resource.fields;
  const tgArn = String(resource.resolvedOutputs?.["targetGroupArn"] ?? "");
  const tgDim = tgArn.split(":targetgroup/").pop() ?? "";
  if (!tgDim) return [];
  const tgDimName = tgDim ? `targetgroup/${tgDim}` : "";
  // Target groups don't store the parent LB ARN; the lister sets
  // `loadBalancerArn` on the field map when known. Without it we can't
  // build a complete dimension set, but querying by TargetGroup alone
  // works for HealthyHostCount/UnHealthyHostCount in many setups.
  const lbArn = String(f.loadBalancerArn ?? "");
  const lbDim = lbArn.split(":loadbalancer/").pop() ?? "";
  const dims = lbDim
    ? [
        { Name: "LoadBalancer", Value: lbDim },
        { Name: "TargetGroup", Value: tgDimName },
      ]
    : [{ Name: "TargetGroup", Value: tgDimName }];
  const [healthy, unhealthy, reqPerTarget, targetRT, targetConnErr] = await Promise.all([
    ctx.fetchCw("AWS/ApplicationELB", "HealthyHostCount", dims).catch(() => null),
    ctx.fetchCw("AWS/ApplicationELB", "UnHealthyHostCount", dims).catch(() => null),
    ctx.fetchCw("AWS/ApplicationELB", "RequestCountPerTarget", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/ApplicationELB", "TargetResponseTime", dims).catch(() => null),
    ctx.fetchCw("AWS/ApplicationELB", "TargetConnectionErrorCount", dims, "Sum").catch(() => null),
  ]);
  const results: MetricSeries[] = [];
  if (healthy && healthy.points.length > 0) results.push({ ...healthy, label: "Healthy Hosts" });
  if (unhealthy && unhealthy.points.length > 0)
    results.push({ ...unhealthy, label: "Unhealthy Hosts" });
  if (reqPerTarget && reqPerTarget.points.length > 0)
    results.push({ ...reqPerTarget, label: "Requests per Target" });
  if (targetRT && targetRT.points.length > 0)
    results.push({ ...targetRT, label: "Target Response Time", unit: "s" });
  if (targetConnErr && targetConnErr.points.length > 0)
    results.push({ ...targetConnErr, label: "Target Conn Errors" });
  return results;
}

export async function cloudFrontDistributionMetrics(
  ctx: MetricsContext,
  resource: ResourceInstance,
): Promise<MetricSeries[]> {
  // Verified against
  // https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/programming-cloudwatch-metrics.html
  // CloudFront metrics only publish in us-east-1 and require
  // Region=Global. CacheHitRate / OriginLatency / 4xx-error / 5xx-error
  // / 4xxErrorRate / 5xxErrorRate require "additional metrics" to be
  // toggled on per distribution — they silently emit nothing otherwise,
  // so listing them costs nothing.
  const distId = String(resource.externalId ?? "");
  if (!distId) return [];
  const dims = [
    { Name: "DistributionId", Value: distId },
    { Name: "Region", Value: "Global" },
  ];
  const [reqs, bytesDown, bytesUp, totalErr, err4xx, err5xx, cacheHit, originLat] =
    await Promise.all([
      ctx.fetchCw("AWS/CloudFront", "Requests", dims, "Sum").catch(() => null),
      ctx.fetchCw("AWS/CloudFront", "BytesDownloaded", dims, "Sum").catch(() => null),
      ctx.fetchCw("AWS/CloudFront", "BytesUploaded", dims, "Sum").catch(() => null),
      ctx.fetchCw("AWS/CloudFront", "TotalErrorRate", dims).catch(() => null),
      ctx.fetchCw("AWS/CloudFront", "4xxErrorRate", dims).catch(() => null),
      ctx.fetchCw("AWS/CloudFront", "5xxErrorRate", dims).catch(() => null),
      ctx.fetchCw("AWS/CloudFront", "CacheHitRate", dims).catch(() => null),
      ctx.fetchCw("AWS/CloudFront", "OriginLatency", dims).catch(() => null),
    ]);
  const results: MetricSeries[] = [];
  if (reqs && reqs.points.length > 0) results.push({ ...reqs, label: "Requests" });
  if (bytesDown && bytesDown.points.length > 0)
    results.push({ ...bytesDown, label: "Bytes Downloaded", unit: "bytes" });
  if (bytesUp && bytesUp.points.length > 0)
    results.push({ ...bytesUp, label: "Bytes Uploaded", unit: "bytes" });
  if (totalErr && totalErr.points.length > 0)
    results.push({ ...totalErr, label: "Total Error Rate", unit: "%" });
  if (err4xx && err4xx.points.length > 0)
    results.push({ ...err4xx, label: "4xx Error Rate", unit: "%" });
  if (err5xx && err5xx.points.length > 0)
    results.push({ ...err5xx, label: "5xx Error Rate", unit: "%" });
  if (cacheHit && cacheHit.points.length > 0)
    results.push({ ...cacheHit, label: "Cache Hit Rate", unit: "%" });
  if (originLat && originLat.points.length > 0)
    results.push({ ...originLat, label: "Origin Latency", unit: "ms" });
  return results;
}

export async function apiGatewayMetrics(
  ctx: MetricsContext,
  resource: ResourceInstance,
): Promise<MetricSeries[]> {
  // Verified against
  // https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-metrics-and-dimensions.html
  // v1 REST APIs publish metrics keyed on `ApiName`; v2 (HTTP/WebSocket)
  // APIs publish on `ApiId`. IntegrationLatency = backend portion of
  // Latency; the difference is API GW's own overhead. CacheHit/Miss only
  // emit when API caching is enabled on the stage.
  const f = resource.fields;
  const protocolType = String(f.protocolType ?? "").toUpperCase();
  const apiId = String(f.apiId ?? resource.externalId ?? "");
  const apiName = String(f.name ?? "");
  const dims =
    protocolType === "REST" && apiName
      ? [{ Name: "ApiName", Value: apiName }]
      : apiId
        ? [{ Name: "ApiId", Value: apiId }]
        : null;
  if (!dims) return [];
  const [count, latency, integrationLat, errors5xx, errors4xx, cacheHit, cacheMiss] =
    await Promise.all([
      ctx.fetchCw("AWS/ApiGateway", "Count", dims, "Sum").catch(() => null),
      ctx.fetchCw("AWS/ApiGateway", "Latency", dims).catch(() => null),
      ctx.fetchCw("AWS/ApiGateway", "IntegrationLatency", dims).catch(() => null),
      ctx.fetchCw("AWS/ApiGateway", "5XXError", dims, "Sum").catch(() => null),
      ctx.fetchCw("AWS/ApiGateway", "4XXError", dims, "Sum").catch(() => null),
      ctx.fetchCw("AWS/ApiGateway", "CacheHitCount", dims, "Sum").catch(() => null),
      ctx.fetchCw("AWS/ApiGateway", "CacheMissCount", dims, "Sum").catch(() => null),
    ]);
  const results: MetricSeries[] = [];
  if (count && count.points.length > 0) results.push({ ...count, label: "Request Count" });
  if (latency && latency.points.length > 0)
    results.push({ ...latency, label: "Latency (total)", unit: "ms" });
  if (integrationLat && integrationLat.points.length > 0)
    results.push({ ...integrationLat, label: "Backend Latency", unit: "ms" });
  if (errors5xx && errors5xx.points.length > 0) results.push({ ...errors5xx, label: "5xx Errors" });
  if (errors4xx && errors4xx.points.length > 0) results.push({ ...errors4xx, label: "4xx Errors" });
  if (cacheHit && cacheHit.points.length > 0) results.push({ ...cacheHit, label: "Cache Hits" });
  if (cacheMiss && cacheMiss.points.length > 0)
    results.push({ ...cacheMiss, label: "Cache Misses" });
  return results;
}

export async function natGatewayMetrics(
  ctx: MetricsContext,
  resource: ResourceInstance,
): Promise<MetricSeries[]> {
  const natId = String(resource.externalId ?? "");
  if (!natId) return [];
  const dims = [{ Name: "NatGatewayId", Value: natId }];
  const [bytesOut, bytesIn, conns] = await Promise.all([
    ctx.fetchCw("AWS/NATGateway", "BytesOutToDestination", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/NATGateway", "BytesInFromDestination", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/NATGateway", "ActiveConnectionCount", dims).catch(() => null),
  ]);
  const results: MetricSeries[] = [];
  if (bytesOut && bytesOut.points.length > 0)
    results.push({ ...bytesOut, label: "Bytes Out", unit: "bytes" });
  if (bytesIn && bytesIn.points.length > 0)
    results.push({ ...bytesIn, label: "Bytes In", unit: "bytes" });
  if (conns && conns.points.length > 0) results.push({ ...conns, label: "Active Connections" });
  return results;
}

export async function route53HealthCheckMetrics(
  ctx: MetricsContext,
  resource: ResourceInstance,
): Promise<MetricSeries[]> {
  // Route 53 metrics live in us-east-1 only. HealthCheckId is the dim.
  // Verified: https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/monitoring-health-checks.html
  const f = resource.fields;
  const id = String(f.healthCheckId ?? resource.externalId ?? "");
  if (!id) return [];
  const dims = [{ Name: "HealthCheckId", Value: id }];
  const [status, healthy, connTime, ttfb] = await Promise.all([
    ctx.fetchCw("AWS/Route53", "HealthCheckStatus", dims, "Minimum").catch(() => null),
    ctx.fetchCw("AWS/Route53", "HealthCheckPercentageHealthy", dims).catch(() => null),
    ctx.fetchCw("AWS/Route53", "ConnectionTime", dims).catch(() => null),
    ctx.fetchCw("AWS/Route53", "TimeToFirstByte", dims).catch(() => null),
  ]);
  const results: MetricSeries[] = [];
  if (status && status.points.length > 0) results.push({ ...status, label: "Health (1=OK)" });
  if (healthy && healthy.points.length > 0)
    results.push({ ...healthy, label: "% Checkers Healthy", unit: "%" });
  if (connTime && connTime.points.length > 0)
    results.push({ ...connTime, label: "Connection Time", unit: "ms" });
  if (ttfb && ttfb.points.length > 0)
    results.push({ ...ttfb, label: "Time to First Byte", unit: "ms" });
  return results;
}
