/**
 * Service metrics from the ClickHouse Cloud Prometheus endpoint,
 * `GET /v1/organizations/{organizationId}/services/{serviceId}/prometheus`
 * (https://clickhouse.com/docs/integrations/prometheus). The body is the
 * Prometheus text exposition format: one sample per metric per replica
 * (`hostname` label), so a reading sums across replicas.
 *
 * The endpoint is a scrape target, not a history API: each call returns the
 * current value only, so the Metrics tab gets one point per series and the
 * host's own sampling builds the trend.
 */

import type { MetricSeries } from "@infrawrench/plugin-base";

export interface PromSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

const SAMPLE_LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(.*)\})?\s+(\S+)(\s+\d+)?$/;
const LABEL_PAIR = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

export function parsePrometheusText(body: string): PromSample[] {
  const samples: PromSample[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = SAMPLE_LINE.exec(line);
    if (!m) continue;
    const value = Number(m[4]);
    if (!Number.isFinite(value)) continue;
    const labels: Record<string, string> = {};
    if (m[3]) {
      for (const pair of m[3].matchAll(LABEL_PAIR)) {
        labels[pair[1]!] = pair[2]!.replace(/\\(.)/g, "$1");
      }
    }
    samples.push({ name: m[1]!, labels, value });
  }
  return samples;
}

interface MetricPick {
  name: string;
  label: string;
  unit?: string;
  /** Divide the summed value by this (bytes to GB, etc.). */
  divisor?: number;
}

/**
 * Standard ClickHouse server metric names (system.metrics,
 * system.asynchronous_metrics, system.events) as the Cloud exporter prefixes
 * them. Only the ones the endpoint actually returns are charted, so a filtered
 * scrape that omits one simply drops that series.
 */
const SERVICE_METRICS: MetricPick[] = [
  { name: "ClickHouseMetrics_Query", label: "Running queries" },
  { name: "ClickHouseMetrics_TCPConnection", label: "Native connections" },
  { name: "ClickHouseMetrics_HTTPConnection", label: "HTTP connections" },
  { name: "ClickHouseMetrics_MySQLConnection", label: "MySQL connections" },
  {
    name: "ClickHouseMetrics_MemoryTracking",
    label: "Memory in use",
    unit: "GB",
    divisor: 1024 ** 3,
  },
  { name: "ClickHouseMetrics_Merge", label: "Running merges" },
  {
    name: "ClickHouseMetrics_BackgroundMergesAndMutationsPoolTask",
    label: "Background merge tasks",
  },
  {
    name: "ClickHouseAsyncMetrics_TotalBytesOfMergeTreeTables",
    label: "MergeTree data size",
    unit: "GB",
    divisor: 1024 ** 3,
  },
  { name: "ClickHouseAsyncMetrics_TotalRowsOfMergeTreeTables", label: "MergeTree rows" },
  { name: "ClickHouseAsyncMetrics_TotalPartsOfMergeTreeTables", label: "MergeTree parts" },
  { name: "ClickHouseAsyncMetrics_MaxPartCountForPartition", label: "Max parts per partition" },
  {
    name: "ClickHouseAsyncMetrics_ReplicasMaxAbsoluteDelay",
    label: "Max replica delay",
    unit: "s",
  },
  { name: "ClickHouseProfileEvents_Query", label: "Queries (cumulative)" },
  { name: "ClickHouseProfileEvents_FailedQuery", label: "Failed queries (cumulative)" },
  { name: "ClickHouseProfileEvents_InsertedRows", label: "Inserted rows (cumulative)" },
  {
    name: "ClickHouseProfileEvents_InsertedBytes",
    label: "Inserted data (cumulative)",
    unit: "GB",
    divisor: 1024 ** 3,
  },
  { name: "ClickHouseProfileEvents_SelectedRows", label: "Selected rows (cumulative)" },
];

/**
 * Metric names whose per-replica values are maxima rather than amounts, so
 * summing replicas would overstate them.
 */
const MAX_ACROSS_REPLICAS = new Set([
  "ClickHouseAsyncMetrics_MaxPartCountForPartition",
  "ClickHouseAsyncMetrics_ReplicasMaxAbsoluteDelay",
]);

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function serviceMetricSeries(body: string, timestamp: number): MetricSeries[] {
  const samples = parsePrometheusText(body);
  const byName = new Map<string, number[]>();
  for (const s of samples) {
    const list = byName.get(s.name) ?? [];
    list.push(s.value);
    byName.set(s.name, list);
  }
  const series: MetricSeries[] = [];
  for (const pick of SERVICE_METRICS) {
    const values = byName.get(pick.name);
    if (!values || values.length === 0) continue;
    const combined = MAX_ACROSS_REPLICAS.has(pick.name)
      ? Math.max(...values)
      : values.reduce((a, b) => a + b, 0);
    series.push({
      label: pick.label,
      ...(pick.unit ? { unit: pick.unit } : {}),
      points: [{ timestamp, value: round(combined / (pick.divisor ?? 1)) }],
    });
  }
  return series;
}

/**
 * ClickPipes counters from the same service scrape, documented in the
 * "ClickPipes metrics" section of the Prometheus integration page. Each
 * sample carries `clickpipe_id`; every one is a lifetime counter, so the
 * labels say so and the trend is the host's sampling of them.
 */
const CLICKPIPE_METRICS: MetricPick[] = [
  { name: "ClickPipes_FetchedEvents_Total", label: "Fetched events (cumulative)" },
  { name: "ClickPipes_SentEvents_Total", label: "Sent events (cumulative)" },
  { name: "ClickPipes_Errors_Total", label: "Errors (cumulative)" },
  { name: "ClickPipes_FetchedBytes_Total", label: "Fetched data (cumulative)", unit: "bytes" },
  {
    name: "ClickPipes_FetchedBytesCompressed_Total",
    label: "Fetched data, compressed (cumulative)",
    unit: "bytes",
  },
  { name: "ClickPipes_SentBytes_Total", label: "Sent data (cumulative)", unit: "bytes" },
  {
    name: "ClickPipes_SentBytesCompressed_Total",
    label: "Sent data, compressed (cumulative)",
    unit: "bytes",
  },
];

export function clickPipeMetricSeries(
  body: string,
  clickPipeId: string,
  timestamp: number,
): MetricSeries[] {
  const samples = parsePrometheusText(body).filter((s) => s.labels["clickpipe_id"] === clickPipeId);
  const series: MetricSeries[] = [];
  for (const pick of CLICKPIPE_METRICS) {
    const values = samples.filter((s) => s.name === pick.name).map((s) => s.value);
    if (values.length === 0) continue;
    series.push({
      label: pick.label,
      ...(pick.unit ? { unit: pick.unit } : {}),
      points: [{ timestamp, value: values.reduce((a, b) => a + b, 0) }],
    });
  }
  return series;
}
