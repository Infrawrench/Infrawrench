/**
 * CloudWatch metric as a business-metric source (the denominator a unit cost
 * divides by): the importer picks a region, namespace, metric, dimension set
 * and statistic, and each run reads that series over the host's day window.
 *
 * API facts verified against the CloudWatch API reference (2026-10):
 *   - ListMetrics (Query API, Version 2010-08-01): `Namespace`, `MetricName`,
 *     `NextToken`; up to 500 metrics per page; response
 *     `ListMetricsResult.Metrics.member[]` with `Namespace`, `MetricName`,
 *     `Dimensions.member[]` (`Name`/`Value`) plus `NextToken`. Only metrics
 *     that reported data in the past two weeks are listed, which is why the
 *     namespace and dimension pickers accept a typed value.
 *   - GetMetricStatistics: at most 1,440 datapoints per call (more is an
 *     error, not a truncation); `Statistics` (SampleCount, Average, Sum,
 *     Minimum, Maximum) or `ExtendedStatistics` (`p0.0`..`p100`), never both;
 *     `EndTime` exclusive; datapoints are not returned in order. 1-hour
 *     datapoints are retained for 455 days, and a start older than 63 days
 *     needs a period that is a multiple of 3600.
 *   - Datapoint.ExtendedStatistics is a string-to-double map, serialized by the
 *     Query protocol as `<entry><key/><value/></entry>`.
 *
 * Read only by construction: both calls are read APIs (`cloudwatch:ListMetrics`,
 * `cloudwatch:GetMetricStatistics`), already part of the preflight's
 * `metrics` capability and its policy template.
 */
import type {
  BusinessMetricSourceDeclaration,
  BusinessMetricSourceOption,
  BusinessMetricSourcePoint,
  BusinessMetricSourceRange,
  BusinessMetricSourceResult,
} from "@infrawrench/plugin-base";
import {
  BUSINESS_METRIC_SOURCE_LIMITS,
  isBusinessMetricDay,
  isValidTimezone,
  localDayOf,
  nextBusinessMetricDay,
  withBusinessMetricTimeout,
  zonedDayStartMs,
} from "@infrawrench/plugin-base";
import type { AwsCredentials } from "./auth.js";
import { queryPostCall } from "./client-transport.js";
import { AWS_REGIONS } from "./constants.js";
import { callGetMetricStatistics } from "./metrics/cw-helpers.js";
import { ensureArray } from "./xml.js";

const CW_VERSION = "2010-08-01";

/** GetMetricStatistics refuses a request that would return more than this. */
export const CW_MAX_DATAPOINTS_PER_CALL = 1440;
/** How long CloudWatch keeps 1-hour datapoints. */
export const CW_HOURLY_RETENTION_DAYS = 455;
/** ListMetrics pages read for one picker (500 metrics each). */
const MAX_LIST_PAGES = 20;
/** Options returned for one picker. */
const MAX_OPTIONS = 1000;

const DAY_MS = 86_400_000;

const STANDARD_STATS = ["Sum", "Average", "Minimum", "Maximum", "SampleCount"] as const;
const PERCENTILE_STATS = ["p50", "p90", "p95", "p99"] as const;

/** Namespaces offered even before the account has published to them. */
const COMMON_NAMESPACES = [
  "AWS/ApiGateway",
  "AWS/ApplicationELB",
  "AWS/AppSync",
  "AWS/Bedrock",
  "AWS/CloudFront",
  "AWS/Cognito",
  "AWS/DynamoDB",
  "AWS/EBS",
  "AWS/EC2",
  "AWS/ECS",
  "AWS/ElastiCache",
  "AWS/ELB",
  "AWS/Events",
  "AWS/Firehose",
  "AWS/Kinesis",
  "AWS/Lambda",
  "AWS/Logs",
  "AWS/NetworkELB",
  "AWS/RDS",
  "AWS/S3",
  "AWS/SNS",
  "AWS/SQS",
  "AWS/States",
  "AWS/Usage",
];

export const AWS_BUSINESS_METRIC_SOURCE: BusinessMetricSourceDeclaration = {
  label: "CloudWatch metric",
  description:
    "Read a CloudWatch metric, such as request counts, processed messages or a custom metric your application publishes, and store one value per day.",
  kind: "metric",
  readOnly: "enforced",
  fields: [
    {
      key: "region",
      label: "Region",
      type: "select",
      required: true,
      description: "The region the metric is published in. The account's region is listed first.",
    },
    {
      key: "namespace",
      label: "Namespace",
      type: "select",
      required: true,
      dependsOn: ["region"],
      allowCustom: true,
      description:
        "AWS service namespaces (AWS/Lambda) or your own custom namespace. CloudWatch only lists metrics that reported data in the past two weeks; type a namespace to use one that is not listed.",
    },
    {
      key: "metricName",
      label: "Metric",
      type: "select",
      required: true,
      dependsOn: ["region", "namespace"],
      allowCustom: true,
    },
    {
      key: "dimensions",
      label: "Dimensions",
      type: "select",
      dependsOn: ["region", "namespace", "metricName"],
      allowCustom: true,
      description:
        "Which series of the metric to read. CloudWatch treats each dimension combination as a separate series, so pick the exact set the metric is published with.",
    },
    {
      key: "stat",
      label: "Statistic",
      type: "select",
      required: true,
      defaultValue: "Sum",
      description:
        "Read hourly, then combined into days by the importer's aggregation. Sum suits counts; for averages and percentiles each day combines hourly values, so a daily figure is an approximation.",
      options: [
        { id: "Sum", label: "Sum", description: "Total of all values; right for counts." },
        { id: "Average", label: "Average" },
        { id: "Minimum", label: "Minimum" },
        { id: "Maximum", label: "Maximum" },
        { id: "SampleCount", label: "Sample count", description: "Number of values published." },
        { id: "p50", label: "p50 (median)" },
        { id: "p90", label: "p90" },
        { id: "p95", label: "p95" },
        { id: "p99", label: "p99" },
      ],
    },
  ],
};

/* ------------------------------------------------------------------ *
 * Dimension set encoding: `Name=Value,Name2=Value2`, with `\`, `,` and
 * `=` inside a name or value escaped by a backslash.
 * ------------------------------------------------------------------ */

export interface CwDimension {
  Name: string;
  Value: string;
}

function escapeDimensionPart(part: string): string {
  return part.replace(/[\\,=]/g, (c) => `\\${c}`);
}

export function encodeDimensions(dimensions: CwDimension[]): string {
  return [...dimensions]
    .sort((a, b) => a.Name.localeCompare(b.Name))
    .map((d) => `${escapeDimensionPart(d.Name)}=${escapeDimensionPart(d.Value)}`)
    .join(",");
}

export function decodeDimensions(encoded: string): CwDimension[] {
  const text = encoded.trim();
  if (!text) return [];
  const pairs: string[][] = [];
  let current: string[] = [""];
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\" && i + 1 < text.length) {
      current[current.length - 1] += text[++i]!;
    } else if (c === "=" && current.length === 1) {
      current.push("");
    } else if (c === ",") {
      pairs.push(current);
      current = [""];
    } else {
      current[current.length - 1] += c;
    }
  }
  pairs.push(current);
  const dims = pairs.map((pair) => {
    const name = pair[0]!.trim();
    if (pair.length !== 2 || !name) {
      throw new Error(
        `Dimensions must be written as Name=Value pairs separated by commas (got "${encoded}").`,
      );
    }
    return { Name: name, Value: pair[1]!.trim() };
  });
  if (dims.length > 30) throw new Error("CloudWatch accepts at most 30 dimensions.");
  return dims;
}

function describeDimensions(dimensions: CwDimension[]): string {
  return [...dimensions]
    .sort((a, b) => a.Name.localeCompare(b.Name))
    .map((d) => `${d.Name}=${d.Value}`)
    .join(", ");
}

/* ------------------------------------------------------------------ *
 * ListMetrics.
 * ------------------------------------------------------------------ */

interface ListedMetric {
  namespace: string;
  metricName: string;
  dimensions: CwDimension[];
}

async function listMetrics(
  creds: AwsCredentials,
  filter: { namespace?: string; metricName?: string },
): Promise<{ metrics: ListedMetric[]; truncated: boolean }> {
  const metrics: ListedMetric[] = [];
  let nextToken: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const params: Record<string, string> = {};
    if (filter.namespace) params["Namespace"] = filter.namespace;
    if (filter.metricName) params["MetricName"] = filter.metricName;
    if (nextToken) params["NextToken"] = nextToken;
    const raw = await queryPostCall<Record<string, unknown>>(
      creds,
      "monitoring",
      "ListMetrics",
      CW_VERSION,
      params,
    );
    const result = (raw["ListMetricsResult"] as Record<string, unknown> | undefined) ?? {};
    const container = result["Metrics"] as Record<string, unknown> | undefined;
    for (const m of ensureArray(container?.["member"]) as Array<Record<string, unknown>>) {
      const dimsContainer = m["Dimensions"] as Record<string, unknown> | undefined;
      const dimensions = (
        ensureArray(dimsContainer?.["member"]) as Array<Record<string, unknown>>
      ).map((d) => ({ Name: String(d["Name"] ?? ""), Value: String(d["Value"] ?? "") }));
      metrics.push({
        namespace: String(m["Namespace"] ?? ""),
        metricName: String(m["MetricName"] ?? ""),
        dimensions,
      });
    }
    const token = result["NextToken"];
    nextToken = typeof token === "string" && token ? token : undefined;
    if (!nextToken) return { metrics, truncated: false };
  }
  return { metrics, truncated: true };
}

function resolveRegion(params: Record<string, string>, homeRegion: string): string {
  const region = (params["region"] ?? "").trim() || homeRegion;
  if (!/^[a-z]{2}(-[a-z]+)+-\d+$/.test(region)) {
    throw new Error(`"${region}" is not an AWS region.`);
  }
  return region;
}

/** Choices for one field of {@link AWS_BUSINESS_METRIC_SOURCE}. */
export async function listCloudWatchSourceOptions(
  credsFor: (region: string) => AwsCredentials,
  homeRegion: string,
  fieldKey: string,
  params: Record<string, string>,
): Promise<BusinessMetricSourceOption[]> {
  switch (fieldKey) {
    case "region": {
      const known = AWS_REGIONS.map((r) => ({
        id: r.id,
        label: r.id === homeRegion ? `${r.id} (account region)` : r.id,
        description: r.location,
      }));
      const home = known.find((r) => r.id === homeRegion) ?? {
        id: homeRegion,
        label: `${homeRegion} (account region)`,
      };
      return [home, ...known.filter((r) => r.id !== homeRegion)];
    }
    case "namespace": {
      const region = resolveRegion(params, homeRegion);
      const { metrics } = await listMetrics(credsFor(region), {});
      const seen = new Set(metrics.map((m) => m.namespace).filter(Boolean));
      const listed = [...seen].sort((a, b) => a.localeCompare(b));
      const custom = listed.filter((n) => !n.startsWith("AWS/"));
      const aws = listed.filter((n) => n.startsWith("AWS/"));
      const common = COMMON_NAMESPACES.filter((n) => !seen.has(n));
      return [
        ...custom.map((n) => ({ id: n, label: n, description: "Custom namespace" })),
        ...aws.map((n) => ({ id: n, label: n })),
        ...common.map((n) => ({
          id: n,
          label: n,
          description: `No recent data in ${region}`,
        })),
      ].slice(0, MAX_OPTIONS);
    }
    case "metricName": {
      const namespace = (params["namespace"] ?? "").trim();
      if (!namespace) return [];
      const region = resolveRegion(params, homeRegion);
      const { metrics } = await listMetrics(credsFor(region), { namespace });
      return [...new Set(metrics.map((m) => m.metricName).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b))
        .slice(0, MAX_OPTIONS)
        .map((n) => ({ id: n, label: n }));
    }
    case "dimensions": {
      const namespace = (params["namespace"] ?? "").trim();
      const metricName = (params["metricName"] ?? "").trim();
      if (!namespace || !metricName) return [];
      const region = resolveRegion(params, homeRegion);
      const { metrics } = await listMetrics(credsFor(region), { namespace, metricName });
      const sets = new Map<string, CwDimension[]>();
      for (const m of metrics) sets.set(encodeDimensions(m.dimensions), m.dimensions);
      const options: BusinessMetricSourceOption[] = [];
      if (sets.has("")) {
        options.push({
          id: "",
          label: "No dimensions",
          description: "The metric's overall series",
        });
        sets.delete("");
      }
      const rest = [...sets.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, dims]) => ({ id, label: describeDimensions(dims) }));
      if (options.length === 0) {
        options.push({
          id: "",
          label: "No dimensions",
          description: "Only for metrics published without dimensions",
        });
      }
      return [...options, ...rest].slice(0, MAX_OPTIONS);
    }
    default:
      return [];
  }
}

/* ------------------------------------------------------------------ *
 * GetMetricStatistics over the day window.
 * ------------------------------------------------------------------ */

function datapointValue(dp: Record<string, unknown>, stat: string, percentile: boolean): number {
  if (!percentile) return Number(dp[stat]);
  const container = dp["ExtendedStatistics"] as Record<string, unknown> | undefined;
  const entries = ensureArray(container?.["entry"]) as Array<Record<string, unknown>>;
  const match = entries.find((e) => String(e["key"]) === stat);
  return match ? Number(match["value"]) : Number.NaN;
}

/** Read the configured series over `range`, one point per CloudWatch period. */
export async function runCloudWatchSource(
  credsFor: (region: string) => AwsCredentials,
  homeRegion: string,
  params: Record<string, string>,
  range: BusinessMetricSourceRange,
  now: number = Date.now(),
): Promise<BusinessMetricSourceResult> {
  const region = resolveRegion(params, homeRegion);
  const namespace = (params["namespace"] ?? "").trim();
  const metricName = (params["metricName"] ?? "").trim();
  const stat = (params["stat"] ?? "").trim() || "Sum";
  if (!namespace) throw new Error("Pick a CloudWatch namespace.");
  if (!metricName) throw new Error("Pick a CloudWatch metric.");
  const percentile = (PERCENTILE_STATS as readonly string[]).includes(stat);
  if (!percentile && !(STANDARD_STATS as readonly string[]).includes(stat)) {
    throw new Error(`"${stat}" is not a supported statistic.`);
  }
  const dimensions = decodeDimensions(params["dimensions"] ?? "");
  if (!isBusinessMetricDay(range.from) || !isBusinessMetricDay(range.to) || range.to < range.from) {
    throw new Error("The import window must be two YYYY-MM-DD days, oldest first.");
  }
  if (!isValidTimezone(range.timezone)) {
    throw new Error(`Unknown timezone "${range.timezone}".`);
  }

  const startMs = zonedDayStartMs(range.from, range.timezone);
  const endMs = Math.min(zonedDayStartMs(nextBusinessMetricDay(range.to), range.timezone), now);
  const maxRows = Math.min(range.maxRows, BUSINESS_METRIC_SOURCE_LIMITS.maxRows);
  // Hourly datapoints exist for 455 days and split a day exactly at local
  // midnight (including DST days). A window reaching further back than that
  // only has what CloudWatch kept, read a day at a time.
  const hourly = startMs >= now - CW_HOURLY_RETENTION_DAYS * DAY_MS;
  const period = hourly ? 3600 : 86_400;
  const chunkMs = CW_MAX_DATAPOINTS_PER_CALL * period * 1000;
  const creds = credsFor(region);

  const work = async (): Promise<BusinessMetricSourceResult> => {
    const points: BusinessMetricSourcePoint[] = [];
    let calls = 0;
    for (let chunkStart = startMs; chunkStart < endMs; chunkStart += chunkMs) {
      if (range.signal?.aborted) throw new Error("The run was cancelled.");
      const chunkEnd = Math.min(chunkStart + chunkMs, endMs);
      const { datapoints } = await callGetMetricStatistics(creds, {
        Namespace: namespace,
        MetricName: metricName,
        Dimensions: dimensions,
        StartTime: new Date(chunkStart).toISOString(),
        EndTime: new Date(chunkEnd).toISOString(),
        Period: period,
        Statistics: percentile ? [] : [stat],
        ...(percentile ? { ExtendedStatistics: [stat] } : {}),
      });
      calls++;
      for (const dp of datapoints) {
        const ts = Date.parse(String(dp["Timestamp"] ?? ""));
        const value = datapointValue(dp, stat, percentile);
        if (!Number.isFinite(ts) || !Number.isFinite(value)) continue;
        // CloudWatch rounds an old start down to the hour; keep only the window.
        if (ts < startMs || ts >= endMs) continue;
        points.push({ date: localDayOf(ts, range.timezone), value });
        if (points.length > maxRows) {
          throw new Error(
            `CloudWatch returned more than ${maxRows} datapoints. Import a shorter window.`,
          );
        }
      }
    }
    points.sort((a, b) => a.date.localeCompare(b.date));
    const series = dimensions.length
      ? `${namespace} ${metricName} (${describeDimensions(dimensions)})`
      : `${namespace} ${metricName}`;
    return {
      points,
      notes: [
        `Read ${points.length} ${hourly ? "hourly" : "daily"} ${stat} datapoints of ${series} in ${region} (${calls} request${calls === 1 ? "" : "s"}).`,
      ],
    };
  };

  return withBusinessMetricTimeout(work(), range);
}
