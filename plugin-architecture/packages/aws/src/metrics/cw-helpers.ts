import type { MetricSeries } from "@infrawrench/plugin-base";
import type { AwsCredentials } from "../auth.js";
import { queryPostCall } from "../client-transport.js";
import { ensureArray } from "../xml.js";

/**
 * CloudWatch (`monitoring`) speaks the AWS Query protocol, not JSON-RPC —
 * sending a JSON-RPC body returns 404 from the endpoint and silently breaks
 * every metric series. Build the `Dimensions.member.N` and `Statistics.member.N`
 * forms the Query API expects.
 */
function buildGetMetricStatisticsParams(input: {
  Namespace: string;
  MetricName: string;
  Dimensions: Array<{ Name: string; Value: string }>;
  StartTime: string;
  EndTime: string;
  Period: number;
  Statistics: string[];
}): Record<string, string> {
  const params: Record<string, string> = {
    Namespace: input.Namespace,
    MetricName: input.MetricName,
    StartTime: input.StartTime,
    EndTime: input.EndTime,
    Period: String(input.Period),
  };
  input.Dimensions.forEach((d, i) => {
    params[`Dimensions.member.${i + 1}.Name`] = d.Name;
    params[`Dimensions.member.${i + 1}.Value`] = d.Value;
  });
  input.Statistics.forEach((s, i) => {
    params[`Statistics.member.${i + 1}`] = s;
  });
  return params;
}

export async function callGetMetricStatistics(
  creds: AwsCredentials,
  params: Parameters<typeof buildGetMetricStatisticsParams>[0],
): Promise<{ label: string; datapoints: Array<Record<string, unknown>> }> {
  const raw = await queryPostCall<Record<string, unknown>>(
    creds,
    "monitoring",
    "GetMetricStatistics",
    "2010-08-01",
    buildGetMetricStatisticsParams(params),
  );
  const result = (raw["GetMetricStatisticsResult"] as Record<string, unknown> | undefined) ?? {};
  const datapointsContainer = result["Datapoints"] as Record<string, unknown> | undefined;
  const datapoints = ensureArray(datapointsContainer?.["member"]) as Array<Record<string, unknown>>;
  return { label: String(result["Label"] ?? ""), datapoints };
}

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
    const { label, datapoints } = await callGetMetricStatistics(callCreds, {
      Namespace: namespace,
      MetricName: metricName,
      Dimensions: dimensions,
      StartTime: new Date(start).toISOString(),
      EndTime: new Date(end).toISOString(),
      Period: period,
      Statistics: [stat],
    });
    return {
      label: metricName,
      unit: label,
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
