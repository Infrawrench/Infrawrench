/**
 * Database metrics. Redis Cloud's REST API publishes no metric history, so a
 * database's Metrics tab is assembled from three sources, each one point per
 * series per read (the host's own sampling of pinned resources builds the
 * trend, the same model the ClickHouse Prometheus scrape uses):
 *
 * 1. The REST API itself: memory used against the dataset limit. Always
 *    available, for Pro and Essentials alike.
 * 2. The subscription's Prometheus endpoint (`prometheusEndpoint` on the Pro
 *    subscription, scraped at `https://<endpoint>:8070/`, the v1 metric set).
 *    It lives on Redis Cloud's internal network, so it answers only through
 *    private connectivity: a bastion attached to the account inside the
 *    peered VPC, or a desktop on that network. Ops/sec, read and write
 *    latency, connections, evictions, expirations, hit ratio and traffic come
 *    from here. When it does not answer, these series are simply absent.
 * 3. The Redis peer tab (`exposeMetricsToParent`): the Redis plugin runs INFO
 *    over the database's public endpoint and contributes ops/sec, clients,
 *    memory and evictions, labelled "Redis · …". That is what fills the tab
 *    for Essentials and for Pro databases without private connectivity.
 */
import type { HttpHostServices, MetricSeries } from "@infrawrench/plugin-base";

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

interface Pick {
  name: string;
  label: string;
  unit?: string;
  scale?: number;
}

/** v1 database gauges (Redis Software metric reference, "Prometheus metrics v1"). */
const DB_METRICS: Pick[] = [
  { name: "bdb_instantaneous_ops_per_sec", label: "Ops/sec", unit: "ops/s" },
  { name: "bdb_read_req", label: "Reads/sec", unit: "ops/s" },
  { name: "bdb_write_req", label: "Writes/sec", unit: "ops/s" },
  // Latencies are reported in seconds; charted in milliseconds.
  { name: "bdb_avg_latency", label: "Latency", unit: "ms", scale: 1000 },
  { name: "bdb_avg_read_latency", label: "Read latency", unit: "ms", scale: 1000 },
  { name: "bdb_avg_write_latency", label: "Write latency", unit: "ms", scale: 1000 },
  { name: "bdb_conns", label: "Connections" },
  { name: "bdb_used_memory", label: "Used memory (Prometheus)", unit: "MB", scale: 1 / 1024 ** 2 },
  { name: "bdb_no_of_keys", label: "Keys" },
  { name: "bdb_evicted_objects", label: "Evictions/sec", unit: "/s" },
  { name: "bdb_expired_objects", label: "Expirations/sec", unit: "/s" },
  { name: "bdb_ingress_bytes", label: "Ingress", unit: "KB/s", scale: 1 / 1024 },
  { name: "bdb_egress_bytes", label: "Egress", unit: "KB/s", scale: 1 / 1024 },
];

function sampleFor(samples: PromSample[], name: string, databaseId: string): number | undefined {
  let total: number | undefined;
  for (const s of samples) {
    if (s.name !== name) continue;
    const id = s.labels["bdb"] ?? s.labels["db"];
    if (id !== databaseId) continue;
    total = (total ?? 0) + s.value;
  }
  return total;
}

/** Turn one scrape into single-point series for one database. */
export function prometheusSeries(
  samples: PromSample[],
  databaseId: string,
  timestamp: number,
): MetricSeries[] {
  const out: MetricSeries[] = [];
  for (const pick of DB_METRICS) {
    const v = sampleFor(samples, pick.name, databaseId);
    if (v === undefined) continue;
    const value = Math.round(v * (pick.scale ?? 1) * 1000) / 1000;
    out.push({
      label: pick.label,
      ...(pick.unit ? { unit: pick.unit } : {}),
      points: [{ timestamp, value }],
    });
  }
  const hits = sampleFor(samples, "bdb_read_hits", databaseId);
  const misses = sampleFor(samples, "bdb_read_misses", databaseId);
  if (hits !== undefined && misses !== undefined && hits + misses > 0) {
    out.push({
      label: "Hit ratio",
      unit: "%",
      points: [{ timestamp, value: Math.round((hits / (hits + misses)) * 10000) / 100 }],
    });
  }
  return out;
}

/** Scrape the subscription's Prometheus endpoint; null when unreachable. */
export async function scrapePrometheus(
  endpoint: string,
  http: HttpHostServices | undefined,
): Promise<PromSample[] | null> {
  const host = endpoint.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const url = `https://${host.includes(":") ? host : `${host}:8070`}/`;
  try {
    if (http) {
      const res = await http.request({ url, method: "GET", headers: { Accept: "text/plain" } });
      if (res.status < 200 || res.status >= 300) return null;
      return parsePrometheusText(res.body);
    }
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return null;
    return parsePrometheusText(await res.text());
  } catch {
    return null;
  }
}

/** Memory used against the dataset limit, straight from the REST API. */
export function memorySeries(
  usedMb: number | undefined,
  datasetGb: number | undefined,
  timestamp: number,
): MetricSeries[] {
  const out: MetricSeries[] = [];
  if (usedMb !== undefined) {
    out.push({ label: "Memory used", unit: "MB", points: [{ timestamp, value: usedMb }] });
  }
  if (usedMb !== undefined && datasetGb) {
    out.push({
      label: "Memory used of limit",
      unit: "%",
      points: [{ timestamp, value: Math.round((usedMb / (datasetGb * 1024)) * 10000) / 100 }],
    });
  }
  return out;
}

/** Default window the Metrics tab labels: the host's sampling covers a day. */
export const METRICS_WINDOW_MS = 24 * 60 * 60 * 1000;
