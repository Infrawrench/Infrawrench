import type { MetricSeries } from "@infrawrench/plugin-base";
import type { AwsCredentials } from "../auth.js";
import { jsonCall } from "../client-transport.js";

/**
 * Shared CloudWatch fetch context for the per-service metric handlers.
 *
 * Each handler receives a `MetricsContext` carrying the resolved time window
 * and the SigV4 credentials, plus a pre-bound `fetchCw` helper that knows the
 * window. Handlers should call `fetchCw` for each datapoint series they need
 * and gate inclusion on `points.length > 0` so empty series are dropped.
 *
 * Some CloudWatch namespaces (CloudFront, Route 53) only publish in
 * us-east-1, regardless of the account's configured region. Pass
 * `regionOverride: "us-east-1"` for those calls so we hit the right
 * endpoint rather than silently getting an empty series back.
 */
export interface MetricsContext {
  readonly creds: AwsCredentials;
  readonly start: number;
  readonly end: number;
  readonly period: number;
  fetchCw(
    namespace: string,
    metricName: string,
    dimensions: Array<{ Name: string; Value: string }>,
    stat?: string,
    options?: { regionOverride?: string },
  ): Promise<MetricSeries>;
}

/** Build a MetricsContext for the given creds and window. */
export function makeMetricsContext(
  creds: AwsCredentials,
  timeRange: { startMs: number; endMs: number } | undefined,
): MetricsContext {
  const now = Date.now();
  const start = timeRange?.startMs ?? now - 3600_000;
  const end = timeRange?.endMs ?? now;
  const period = Math.max(60, Math.floor((end - start) / 60_000));

  const fetchCw = async (
    namespace: string,
    metricName: string,
    dimensions: Array<{ Name: string; Value: string }>,
    stat = "Average",
    options?: { regionOverride?: string },
  ): Promise<MetricSeries> => {
    const callCreds = options?.regionOverride
      ? { ...creds, region: options.regionOverride }
      : creds;
    const data = await jsonCall<Record<string, unknown>>(
      callCreds,
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

  return { creds, start, end, period, fetchCw };
}
