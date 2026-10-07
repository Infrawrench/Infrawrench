/**
 * Metrics come from Astra's Prometheus scrape endpoint
 * (`https://metrics.astra.datastax.com/v1/databases/{id}/metrics` and
 * `/v1/pcugroup/{id}/metrics`, `Authorization: Astra-Token <token>`, a paid
 * plan feature; docs "Scrape Astra DB Serverless metrics", 2026-10). Each
 * scrape is the current value of every series (the `:rate1m` recordings), so
 * a read yields one point per series and the host's sampling of pinned
 * resources builds the trend. A free organization answers 4xx and the tab
 * stays empty.
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
      for (const pair of m[3].matchAll(LABEL_PAIR))
        labels[pair[1]!] = pair[2]!.replace(/\\(.)/g, "$1");
    }
    samples.push({ name: m[1]!, labels, value });
  }
  return samples;
}

interface Pick {
  name: string;
  label: string;
  unit: string;
  scale?: number;
}

export const DATABASE_METRICS: Pick[] = [
  { name: "astra_billing_report_tenant_requests_total:rate1m", label: "Requests", unit: "req/s" },
  {
    name: "astra_cql_org_apache_cassandra_metrics_Client_connectedNativeClients:rate1m",
    label: "CQL connections",
    unit: "connections",
  },
  {
    name: "astra_db_read_latency_seconds_P99:rate1m",
    label: "Read latency p99",
    unit: "ms",
    scale: 1000,
  },
  {
    name: "astra_db_read_latency_seconds_P50:rate1m",
    label: "Read latency p50",
    unit: "ms",
    scale: 1000,
  },
  {
    name: "astra_db_write_latency_seconds_P99:rate1m",
    label: "Write latency p99",
    unit: "ms",
    scale: 1000,
  },
  {
    name: "astra_db_write_latency_seconds_P50:rate1m",
    label: "Write latency p50",
    unit: "ms",
    scale: 1000,
  },
  {
    name: "astra_db_range_latency_seconds_P99:rate1m",
    label: "Range read latency p99",
    unit: "ms",
    scale: 1000,
  },
  { name: "astra_db_read_requests_failures:rate1m", label: "Read failures", unit: "/s" },
  { name: "astra_db_write_requests_failures:rate1m", label: "Write failures", unit: "/s" },
  { name: "astra_db_read_requests_timeouts:rate1m", label: "Read timeouts", unit: "/s" },
  { name: "astra_db_write_requests_timeouts:rate1m", label: "Write timeouts", unit: "/s" },
  { name: "astra_db_rate_limited_requests:rate1m", label: "Rate-limited requests", unit: "/s" },
  { name: "astra_db_read_failure_tombstone:rate1m", label: "Tombstone read failures", unit: "/s" },
];

export const PCU_METRICS: Pick[] = [
  { name: "astra_pcu_group_cpu_utilization", label: "CPU utilization", unit: "%" },
  { name: "astra_pcu_group_cache_utilization", label: "Cache utilization", unit: "%" },
  { name: "astra_pcu_group_read_latency_ms", label: "Read latency (median)", unit: "ms" },
  { name: "astra_pcu_group_actual_pcu", label: "PCUs in use", unit: "PCU" },
  { name: "astra_pcu_group_current_rcu", label: "Reserved capacity units in use", unit: "RCU" },
  { name: "astra_pcu_group_current_hcu", label: "Hourly capacity units in use", unit: "HCU" },
  { name: "astra_pcu_group_reserved_pcu_count", label: "Reserved PCUs", unit: "PCU" },
  { name: "astra_pcu_group_max_pcu_count", label: "Maximum PCUs", unit: "PCU" },
];

/**
 * One point per picked series, summed across label sets (one per region for
 * a multi-region database) except latencies, which take the worst region.
 */
export function samplesToSeries(samples: PromSample[], picks: Pick[], now: number): MetricSeries[] {
  const out: MetricSeries[] = [];
  for (const pick of picks) {
    const values = samples.filter((s) => s.name === pick.name).map((s) => s.value);
    if (!values.length) continue;
    const isLatency = pick.unit === "ms";
    const combined = isLatency ? Math.max(...values) : values.reduce((a, b) => a + b, 0);
    out.push({
      label: pick.label,
      unit: pick.unit,
      points: [{ timestamp: now, value: Math.round(combined * (pick.scale ?? 1) * 1000) / 1000 }],
    });
  }
  return out;
}
