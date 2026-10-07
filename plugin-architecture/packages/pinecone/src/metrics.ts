import type { MetricSeries } from "@infrawrench/plugin-base";
import { API_HOST, isStatus, type PineconeApi } from "./api.js";
import type { PcIndexStats, PcPrometheusTarget } from "./types.js";

/**
 * Pinecone has no time-series query API. What it offers is point-in-time:
 *
 * - `POST https://{index host}/describe_index_stats`: record count,
 *   namespace count, dimension and (pod / dedicated) fullness. Works for
 *   every deployment type with the project API key.
 * - A Prometheus endpoint per project: HTTP service discovery at
 *   `GET /prometheus/projects/{project_id}/metrics/discovery` returns scrape
 *   targets, each scraped with the API key as a Bearer token. Serverless and
 *   BYOC indexes only; every sample carries an `index_name` label. The
 *   published OpenAPI spec spells the path `.../metrics/discover`, the docs
 *   `.../metrics/discovery`; both are tried.
 *
 * Each call therefore returns the *current* value as a one-point series; the
 * host's metrics warehouse stores successive readings, which is what turns
 * them into a history. Prometheus counters are cumulative and reported as is.
 */

interface Spec {
  label: string;
  unit: string;
  scale?: number;
}

/** Prometheus metric name → series label. Names from Pinecone's monitoring guide (2026-10). */
export const PROMETHEUS_METRICS: Record<string, Spec> = {
  pinecone_db_record_total: { label: "Records (Prometheus)", unit: "records" },
  pinecone_db_storage_size_bytes: { label: "Storage Size", unit: "bytes" },
  pinecone_db_op_upsert_count: { label: "Upserts (cumulative)", unit: "requests" },
  pinecone_db_op_query_count: { label: "Queries (cumulative)", unit: "requests" },
  pinecone_db_op_fetch_count: { label: "Fetches (cumulative)", unit: "requests" },
  pinecone_db_op_update_count: { label: "Updates (cumulative)", unit: "requests" },
  pinecone_db_op_delete_count: { label: "Deletes (cumulative)", unit: "requests" },
  pinecone_db_op_list_count: { label: "Lists (cumulative)", unit: "requests" },
  pinecone_db_op_query_duration_sum: {
    label: "Query Time (cumulative)",
    unit: "ms",
  },
  pinecone_db_op_upsert_duration_sum: {
    label: "Upsert Time (cumulative)",
    unit: "ms",
  },
  pinecone_db_read_unit_count: { label: "Read Units (cumulative)", unit: "RU" },
  pinecone_db_write_unit_count: { label: "Write Units (cumulative)", unit: "WU" },
  pinecone_db_drn_cpu_usage_percent: { label: "Read Node CPU", unit: "%" },
  pinecone_db_index_fullness: { label: "Index Fullness", unit: "%", scale: 100 },
  pinecone_db_memory_fullness: { label: "Memory Fullness", unit: "%", scale: 100 },
  pinecone_db_storage_fullness: { label: "Storage Fullness", unit: "%", scale: 100 },
  pinecone_db_scheduled_backup_failure_total: {
    label: "Scheduled Backup Failures",
    unit: "failures",
  },
};

/** Gauges that are averaged across shards/instances instead of summed. */
const AVERAGED = new Set([
  "pinecone_db_drn_cpu_usage_percent",
  "pinecone_db_index_fullness",
  "pinecone_db_memory_fullness",
  "pinecone_db_storage_fullness",
]);

export interface PromSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/** Minimal Prometheus text-exposition parser (`name{a="b",c="d"} value [ts]`). */
export function parsePrometheusText(text: string): PromSample[] {
  const out: PromSample[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const brace = line.indexOf("{");
    let name: string;
    let rest: string;
    const labels: Record<string, string> = {};
    if (brace >= 0) {
      name = line.slice(0, brace);
      const close = line.lastIndexOf("}");
      if (close < brace) continue;
      const body = line.slice(brace + 1, close);
      const re = /([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(body)) !== null) {
        labels[m[1]!] = m[2]!.replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
      }
      rest = line.slice(close + 1).trim();
    } else {
      const sp = line.search(/\s/);
      if (sp < 0) continue;
      name = line.slice(0, sp);
      rest = line.slice(sp + 1).trim();
    }
    const value = Number(rest.split(/\s+/)[0]);
    if (!Number.isFinite(value)) continue;
    out.push({ name, labels, value });
  }
  return out;
}

/** Fold samples for one index into one current-value series per metric. */
export function prometheusSeries(
  samples: PromSample[],
  indexName: string,
  now: number,
): MetricSeries[] {
  const acc = new Map<string, { sum: number; n: number }>();
  for (const s of samples) {
    if (s.labels["index_name"] !== indexName) continue;
    if (!PROMETHEUS_METRICS[s.name]) continue;
    const a = acc.get(s.name) ?? { sum: 0, n: 0 };
    a.sum += s.value;
    a.n += 1;
    acc.set(s.name, a);
  }
  const out: MetricSeries[] = [];
  for (const [name, a] of acc) {
    const spec = PROMETHEUS_METRICS[name]!;
    const v = AVERAGED.has(name) ? a.sum / a.n : a.sum;
    out.push({
      label: spec.label,
      unit: spec.unit,
      points: [{ timestamp: now, value: v * (spec.scale ?? 1) }],
    });
  }
  return out;
}

export function statsSeries(stats: PcIndexStats, now: number): MetricSeries[] {
  const out: MetricSeries[] = [];
  const point = (label: string, unit: string, value: number | undefined) => {
    if (value === undefined || value === null || !Number.isFinite(value)) return;
    out.push({ label, unit, points: [{ timestamp: now, value }] });
  };
  point("Records", "records", stats.totalVectorCount);
  point("Namespaces", "namespaces", Object.keys(stats.namespaces ?? {}).length);
  // Fullness is a 0 to 1 fraction, always 0 for on-demand serverless indexes.
  if (stats.indexFullness) point("Fullness", "%", stats.indexFullness * 100);
  if (stats.memoryFullness) point("Memory Fullness (stats)", "%", stats.memoryFullness * 100);
  if (stats.storageFullness) point("Storage Fullness (stats)", "%", stats.storageFullness * 100);
  return out;
}

export async function fetchIndexStats(api: PineconeApi, host: string): Promise<PcIndexStats> {
  return api.dataPlane<PcIndexStats>(host, "/describe_index_stats", {
    method: "POST",
    body: {},
  });
}

/** Scrape every target the project's discovery endpoint returns. */
export async function scrapeProject(api: PineconeApi, projectId: string): Promise<PromSample[]> {
  const base = `${API_HOST}/prometheus/projects/${encodeURIComponent(projectId)}/metrics`;
  let body: string;
  try {
    body = await api.prometheus(`${base}/discovery`, false);
  } catch (e) {
    if (!isStatus(e, 404)) throw e;
    body = await api.prometheus(`${base}/discover`, false);
  }
  const targets = (JSON.parse(body || "[]") as PcPrometheusTarget[]).flatMap(
    (t) => t.targets ?? [],
  );
  const texts = await Promise.all(
    targets
      .slice(0, 20)
      .map((t) =>
        api.prometheus(/^https?:\/\//.test(t) ? t : `https://${t}`, true).catch(() => ""),
      ),
  );
  return texts.flatMap(parsePrometheusText);
}
