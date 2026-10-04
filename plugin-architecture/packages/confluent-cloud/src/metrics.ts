/**
 * Confluent Cloud Metrics API (`POST /v2/metrics/cloud/query` on
 * api.telemetry.confluent.cloud). Verified 2026-10 against the API's own
 * reference (https://api.telemetry.confluent.cloud/docs) and the public
 * metric descriptors (`/v2/metrics/cloud/descriptors/metrics`).
 *
 * Constraints that shape this module:
 * - One aggregation per request, so every series is its own query.
 * - Metrics are retained for seven days; anything older is clamped away.
 * - Granularity is bounded by interval length (PT1M up to 6 hours, PT5M up
 *   to a day, PT15M up to 4 days, PT30M up to 7 days; PT1H and coarser for
 *   any interval).
 * - Counter metrics (`received_bytes`, `sent_records`, ...) are deltas per
 *   60-second sample, so a SUM over a bucket is "bytes in that bucket";
 *   charts divide by the bucket length to show a per-second rate.
 * - The key's owner needs MetricsViewer (or OrganizationAdmin).
 */

import type { MetricSeries, MetricSeriesPoint } from "@infrawrench/plugin-base";
import type { ConfluentContext } from "./api.js";
import { TELEMETRY_API, ccFetch } from "./api.js";

export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_METRICS_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Data lands up to a few minutes late; querying to `now` leaves a ragged last bucket. */
const LATENCY_MS = 3 * 60 * 1000;

export type Granularity = "PT1M" | "PT5M" | "PT15M" | "PT30M" | "PT1H" | "P1D" | "ALL";

const GRANULARITY_SECONDS: Record<Exclude<Granularity, "ALL">, number> = {
  PT1M: 60,
  PT5M: 300,
  PT15M: 900,
  PT30M: 1800,
  PT1H: 3600,
  P1D: 86400,
};

export interface TimeRange {
  startMs: number;
  endMs: number;
}

export function rangeOrDefault(range: TimeRange | undefined, now = Date.now()): TimeRange {
  const endMs = Math.min(range?.endMs ?? now, now - LATENCY_MS);
  const wanted = range?.startMs ?? endMs - DEFAULT_METRICS_WINDOW_MS;
  const startMs = Math.max(wanted, now - RETENTION_MS + 60_000);
  return { startMs: Math.min(startMs, endMs - 60_000), endMs };
}

/** The finest granularity the API accepts for an interval of this length. */
export function granularityFor(range: TimeRange): Exclude<Granularity, "ALL"> {
  const hours = (range.endMs - range.startMs) / 3_600_000;
  if (hours <= 6) return "PT1M";
  if (hours <= 24) return "PT5M";
  if (hours <= 96) return "PT15M";
  if (hours <= 168) return "PT30M";
  return "PT1H";
}

function iso(ms: number): string {
  // Minute-aligned: the API rejects sub-minute precision on some granularities.
  return new Date(Math.floor(ms / 60_000) * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export type Filter =
  { op: "EQ"; field: string; value: string } | { op: "OR" | "AND"; filters: Filter[] };

/** `resource.kafka.id = a OR … `: the API wants an explicit resource filter. */
export function anyOf(field: string, values: string[]): Filter {
  const unique = [...new Set(values.filter(Boolean))];
  if (unique.length === 1) return { op: "EQ", field, value: unique[0]! };
  return { op: "OR", filters: unique.map((value) => ({ op: "EQ" as const, field, value })) };
}

export interface QueryRequest {
  metric: string;
  agg?: "SUM" | "MAX" | "MIN";
  filter: Filter;
  groupBy?: string[];
  granularity: Granularity;
  range: TimeRange;
  limit?: number;
}

interface FlatPoint {
  timestamp?: string;
  value?: number;
  [label: string]: unknown;
}

interface QueryResponse {
  data?: Array<FlatPoint & { points?: FlatPoint[] }>;
  meta?: { pagination?: { next_page_token?: string } };
}

/** One query, flat format: `{ timestamp, value, <group labels> }[]`. */
export async function queryMetric(ctx: ConfluentContext, req: QueryRequest): Promise<FlatPoint[]> {
  const body = {
    aggregations: [{ metric: req.metric, ...(req.agg ? { agg: req.agg } : {}) }],
    filter: req.filter,
    granularity: req.granularity,
    intervals: [`${iso(req.range.startMs)}/${iso(req.range.endMs)}`],
    ...(req.groupBy && req.groupBy.length > 0 ? { group_by: req.groupBy } : {}),
    ...(req.limit ? { limit: req.limit } : {}),
    format: "FLAT",
  };
  const res = await ccFetch<QueryResponse>(ctx, "/v2/metrics/cloud/query", {
    base: TELEMETRY_API,
    method: "POST",
    body: JSON.stringify(body),
  });
  const out: FlatPoint[] = [];
  for (const row of res?.data ?? []) {
    if (Array.isArray(row.points)) {
      // Grouped format, should the API ever ignore `format: FLAT`.
      const { points, ...labels } = row;
      for (const p of points) out.push({ ...labels, ...p });
    } else {
      out.push(row);
    }
  }
  return out;
}

/** How one chart is computed from one metric. */
export interface SeriesSpec {
  label: string;
  metric: string;
  agg?: "SUM" | "MAX" | "MIN";
  unit?: string;
  /** Delta counters: divide each bucket by its length to chart a rate. */
  perSecond?: boolean;
  /** Multiply each value (e.g. 100 for a 0..1 fraction shown as a percent). */
  scale?: number;
  /** Only for these cluster types (Dedicated-only metrics). */
  onlyFor?: (clusterType: string) => boolean;
}

/** Run each spec against one resource; a failed series is simply absent. */
export async function seriesFor(
  ctx: ConfluentContext,
  filterField: string,
  resourceIdValue: string,
  specs: SeriesSpec[],
  range: TimeRange,
): Promise<MetricSeries[]> {
  const granularity = granularityFor(range);
  const bucketSeconds = GRANULARITY_SECONDS[granularity];
  const results = await Promise.all(
    specs.map(async (spec): Promise<MetricSeries | null> => {
      try {
        const rows = await queryMetric(ctx, {
          metric: spec.metric,
          ...(spec.agg ? { agg: spec.agg } : {}),
          filter: { op: "EQ", field: filterField, value: resourceIdValue },
          granularity,
          range,
        });
        const points: MetricSeriesPoint[] = [];
        for (const r of rows) {
          if (typeof r.value !== "number" || !Number.isFinite(r.value) || !r.timestamp) continue;
          const ts = Date.parse(r.timestamp);
          if (!Number.isFinite(ts)) continue;
          let value = r.value;
          if (spec.perSecond) value = value / bucketSeconds;
          if (spec.scale) value = value * spec.scale;
          points.push({ timestamp: ts, value });
        }
        points.sort((a, b) => a.timestamp - b.timestamp);
        if (points.length === 0) return null;
        return { label: spec.label, ...(spec.unit ? { unit: spec.unit } : {}), points };
      } catch {
        return null;
      }
    }),
  );
  return results.filter((s): s is MetricSeries => s !== null);
}

const isDedicated = (t: string) => t === "Dedicated";
const isElastic = (t: string) => t !== "" && t !== "Dedicated";

export const CLUSTER_SERIES: SeriesSpec[] = [
  {
    label: "Bytes in",
    metric: "io.confluent.kafka.server/received_bytes",
    agg: "SUM",
    unit: "B/s",
    perSecond: true,
  },
  {
    label: "Bytes out",
    metric: "io.confluent.kafka.server/sent_bytes",
    agg: "SUM",
    unit: "B/s",
    perSecond: true,
  },
  {
    label: "Records in",
    metric: "io.confluent.kafka.server/received_records",
    agg: "SUM",
    unit: "records/s",
    perSecond: true,
  },
  {
    label: "Records out",
    metric: "io.confluent.kafka.server/sent_records",
    agg: "SUM",
    unit: "records/s",
    perSecond: true,
  },
  {
    label: "Requests",
    metric: "io.confluent.kafka.server/request_count",
    agg: "SUM",
    unit: "req/s",
    perSecond: true,
  },
  {
    label: "Retained bytes",
    metric: "io.confluent.kafka.server/retained_bytes",
    agg: "SUM",
    unit: "B",
  },
  { label: "Partitions", metric: "io.confluent.kafka.server/partition_count", agg: "SUM" },
  {
    label: "Active connections",
    metric: "io.confluent.kafka.server/active_connection_count",
    agg: "SUM",
  },
  {
    label: "Max consumer lag",
    metric: "io.confluent.kafka.server/consumer_lag_offsets",
    agg: "MAX",
    unit: "offsets",
  },
  {
    // The rightsizing declaration reads this label; keep them in step.
    label: "CKU utilization",
    metric: "io.confluent.kafka.server/cluster_load_percent",
    agg: "MAX",
    unit: "%",
    scale: 100,
    onlyFor: isDedicated,
  },
  {
    label: "CKUs",
    metric: "io.confluent.kafka.server/dedicated_cku_count",
    agg: "MAX",
    onlyFor: isDedicated,
  },
  {
    label: "eCKUs",
    metric: "io.confluent.kafka.server/elastic_cku_count",
    agg: "MAX",
    onlyFor: isElastic,
  },
];

export const CONNECTOR_SERIES: SeriesSpec[] = [
  {
    label: "Records sent",
    metric: "io.confluent.kafka.connect/sent_records",
    agg: "SUM",
    unit: "records/s",
    perSecond: true,
  },
  {
    label: "Records received",
    metric: "io.confluent.kafka.connect/received_records",
    agg: "SUM",
    unit: "records/s",
    perSecond: true,
  },
  {
    label: "Bytes sent",
    metric: "io.confluent.kafka.connect/sent_bytes",
    agg: "SUM",
    unit: "B/s",
    perSecond: true,
  },
  {
    label: "Bytes received",
    metric: "io.confluent.kafka.connect/received_bytes",
    agg: "SUM",
    unit: "B/s",
    perSecond: true,
  },
  {
    label: "Dead letter queue records",
    metric: "io.confluent.kafka.connect/dead_letter_queue_records",
    agg: "SUM",
  },
  {
    label: "Max records lag",
    metric: "io.confluent.kafka.connect/records_lag_max",
    agg: "MAX",
  },
];

export const COMPUTE_POOL_SERIES: SeriesSpec[] = [
  {
    label: "Current CFUs",
    metric: "io.confluent.flink/compute_pool_utilization/current_cfus",
    agg: "MAX",
  },
  {
    label: "CFU limit",
    metric: "io.confluent.flink/compute_pool_utilization/cfu_limit",
    agg: "MAX",
  },
  {
    label: "CFU minutes consumed",
    metric: "io.confluent.flink/compute_pool_utilization/cfu_minutes_consumed",
    agg: "SUM",
  },
];

export const KSQL_SERIES: SeriesSpec[] = [
  { label: "CSUs", metric: "io.confluent.kafka.ksql/streaming_unit_count", agg: "MAX" },
  {
    label: "Max query saturation",
    metric: "io.confluent.kafka.ksql/query_saturation",
    agg: "MAX",
    unit: "%",
    scale: 100,
  },
  {
    label: "Storage utilization",
    metric: "io.confluent.kafka.ksql/storage_utilization",
    agg: "MAX",
    unit: "%",
    scale: 100,
  },
  {
    label: "Processing errors",
    metric: "io.confluent.kafka.ksql/processing_errors_total",
    agg: "SUM",
  },
  {
    label: "Bytes consumed",
    metric: "io.confluent.kafka.ksql/consumed_total_bytes",
    agg: "SUM",
    unit: "B/s",
    perSecond: true,
  },
];

export const SCHEMA_REGISTRY_SERIES: SeriesSpec[] = [
  { label: "Schemas", metric: "io.confluent.kafka.schema_registry/schema_count", agg: "MAX" },
  {
    label: "Requests",
    metric: "io.confluent.kafka.schema_registry/request_count",
    agg: "SUM",
    unit: "req/s",
    perSecond: true,
  },
];

// ---------------------------------------------------------------------------
// Listing-time enrichment: one grouped query per metric for every resource.
// ---------------------------------------------------------------------------

/** Value per group label from a granularity=ALL query. */
async function totalsBy(
  ctx: ConfluentContext,
  metric: string,
  agg: "SUM" | "MAX",
  field: string,
  ids: string[],
  range: TimeRange,
  extraGroup?: string,
): Promise<FlatPoint[]> {
  return queryMetric(ctx, {
    metric,
    agg,
    filter: anyOf(field, ids),
    groupBy: extraGroup ? [field, extraGroup] : [field],
    granularity: "ALL",
    range,
    limit: 1000,
  });
}

function sumByLabel(rows: FlatPoint[], label: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const key = r[label];
    if (typeof key !== "string" || typeof r.value !== "number") continue;
    out.set(key, (out.get(key) ?? 0) + r.value);
  }
  return out;
}

export interface ClusterUsageMap {
  topics: Map<string, number>;
  partitions: Map<string, number>;
  retainedBytes: Map<string, number>;
  bytesIn: Map<string, number>;
  bytesOut: Map<string, number>;
  /** True when the 7-day throughput queries succeeded. */
  throughputKnown: boolean;
}

/**
 * Topic count, partitions, retained bytes and 7-day bytes in/out for many
 * clusters at once. A cluster with zero traffic has no rows at all, so a
 * successful query with no row for a cluster means zero; a failed query
 * leaves every value unknown (absent), which keeps the idle rule quiet.
 *
 * Topics are counted as distinct `metric.topic` labels on `retained_bytes`
 * over the last hour: the management API cannot list topics with a Cloud
 * API key (the Kafka REST API wants a cluster key), and every topic retains
 * at least its segment metadata.
 */
export async function fetchClusterUsage(
  ctx: ConfluentContext,
  clusterIds: string[],
  now = Date.now(),
): Promise<ClusterUsageMap> {
  const field = "resource.kafka.id";
  const label = field;
  const empty: ClusterUsageMap = {
    topics: new Map(),
    partitions: new Map(),
    retainedBytes: new Map(),
    bytesIn: new Map(),
    bytesOut: new Map(),
    throughputKnown: false,
  };
  if (clusterIds.length === 0) return empty;
  const end = now - LATENCY_MS;
  const lastHour: TimeRange = { startMs: end - 60 * 60 * 1000, endMs: end };
  const week: TimeRange = { startMs: now - RETENTION_MS + 60 * 60 * 1000, endMs: end };
  const [topicRows, partitionRows, retainedRows, inRows, outRows] = await Promise.all([
    totalsBy(
      ctx,
      "io.confluent.kafka.server/retained_bytes",
      "MAX",
      field,
      clusterIds,
      lastHour,
      "metric.topic",
    ).catch(() => null),
    totalsBy(
      ctx,
      "io.confluent.kafka.server/partition_count",
      "MAX",
      field,
      clusterIds,
      lastHour,
    ).catch(() => null),
    totalsBy(
      ctx,
      "io.confluent.kafka.server/retained_bytes",
      "MAX",
      field,
      clusterIds,
      lastHour,
    ).catch(() => null),
    totalsBy(ctx, "io.confluent.kafka.server/received_bytes", "SUM", field, clusterIds, week).catch(
      () => null,
    ),
    totalsBy(ctx, "io.confluent.kafka.server/sent_bytes", "SUM", field, clusterIds, week).catch(
      () => null,
    ),
  ]);
  const out = { ...empty };
  if (topicRows) {
    const topics = new Map<string, Set<string>>();
    for (const r of topicRows) {
      const cluster = r[label];
      const topic = r["metric.topic"];
      if (typeof cluster !== "string" || typeof topic !== "string") continue;
      if (!topics.has(cluster)) topics.set(cluster, new Set());
      topics.get(cluster)!.add(topic);
    }
    for (const id of clusterIds) out.topics.set(id, topics.get(id)?.size ?? 0);
  }
  if (partitionRows) out.partitions = sumByLabel(partitionRows, label);
  if (retainedRows) out.retainedBytes = sumByLabel(retainedRows, label);
  if (inRows && outRows) {
    out.bytesIn = sumByLabel(inRows, label);
    out.bytesOut = sumByLabel(outRows, label);
    out.throughputKnown = true;
  }
  return out;
}

export interface ConnectorUsageMap {
  recordsIn: Map<string, number>;
  recordsOut: Map<string, number>;
  known: boolean;
}

/** 7-day records in/out per connector id (`lcc-…`). */
export async function fetchConnectorUsage(
  ctx: ConfluentContext,
  connectorIds: string[],
  now = Date.now(),
): Promise<ConnectorUsageMap> {
  const field = "resource.connector.id";
  const result: ConnectorUsageMap = { recordsIn: new Map(), recordsOut: new Map(), known: false };
  if (connectorIds.length === 0) return result;
  const week: TimeRange = { startMs: now - RETENTION_MS + 60 * 60 * 1000, endMs: now - LATENCY_MS };
  const [received, sent] = await Promise.all([
    totalsBy(ctx, "io.confluent.kafka.connect/received_records", "SUM", field, connectorIds, week),
    totalsBy(ctx, "io.confluent.kafka.connect/sent_records", "SUM", field, connectorIds, week),
  ]).catch(() => [null, null] as const);
  if (!received || !sent) return result;
  // Sink connectors receive from Kafka; source connectors send to it.
  result.recordsIn = sumByLabel(received, field);
  result.recordsOut = sumByLabel(sent, field);
  result.known = true;
  return result;
}
