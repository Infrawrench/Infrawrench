/**
 * Metrics and logs for Databricks resources. Everything here is a pure
 * transform from an API response into `MetricSeries` or log text, so the
 * client only issues the requests and the shaping is unit-tested on its own.
 *
 * Sources, all workspace REST unless noted:
 * - Serving endpoints: `GET /api/2.0/serving-endpoints/{name}/metrics`
 *   (OpenMetrics text: CPU/memory %, request and error counts, latency
 *   histograms) and the served-model `logs` / `build-logs` endpoints.
 * - Clusters: `POST /api/2.1/clusters/events` (activity log; worker counts
 *   ride along in `details.current_num_workers`) and the
 *   `system.compute.node_timeline` system table (per-minute CPU, memory and
 *   network per node), read through the Statement Execution API.
 * - SQL warehouses: `GET /api/2.0/sql/history/queries` bucketed client-side.
 * - Jobs: `GET /api/2.2/jobs/runs/list` (one point per run).
 * - Pipelines: `GET /api/2.0/pipelines/{id}/events` (the event log).
 */

import type { MetricSeries } from "@infrawrench/plugin-base";

// ── Prometheus / OpenMetrics text ───────────────────────────────────────────

interface PromSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

const SAMPLE_LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(.*)\})?\s+(\S+)(\s+\S+)?$/;
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

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Serving endpoint health metrics, as documented at
 * https://docs.databricks.com/aws/en/machine-learning/model-serving/metrics-export-serving-endpoint.
 * The export is a scrape target (current values only), so each series is one
 * point and the host's sampling builds the trend. Utilisation is averaged
 * across the samples the endpoint returns (one per served entity/replica);
 * counts are summed. The three latency histograms are reduced to their mean
 * (`_sum / _count`), which is the one statistic a histogram always carries.
 */
export function servingEndpointSeries(body: string, timestamp: number): MetricSeries[] {
  const samples = parsePrometheusText(body);
  const values = (name: string) => samples.filter((s) => s.name === name).map((s) => s.value);
  const out: MetricSeries[] = [];
  const point = (label: string, value: number, unit?: string) =>
    out.push({ label, ...(unit ? { unit } : {}), points: [{ timestamp, value: round2(value) }] });

  for (const [name, label] of [
    ["cpu_usage_percentage", "CPU usage"],
    ["mem_usage_percentage", "Memory usage"],
  ] as const) {
    const v = values(name);
    if (v.length > 0) point(label, v.reduce((a, b) => a + b, 0) / v.length, "%");
  }
  for (const [name, label] of [
    ["request_count_total", "Requests"],
    ["request_4xx_count_total", "4xx errors"],
    ["request_5xx_count_total", "5xx errors"],
    ["provisioned_concurrent_requests_total", "Provisioned concurrency"],
  ] as const) {
    const v = values(name);
    if (v.length > 0)
      point(
        label,
        v.reduce((a, b) => a + b, 0),
      );
  }
  for (const [name, label] of [
    ["request_latency_ms", "Avg request latency"],
    ["model_prediction_latency_ms", "Avg model inference latency"],
    ["model_queue_time_ms", "Avg request queue time"],
  ] as const) {
    const sum = values(`${name}_sum`).reduce((a, b) => a + b, 0);
    const count = values(`${name}_count`).reduce((a, b) => a + b, 0);
    if (count > 0) point(label, sum / count, "ms");
  }
  return out;
}

/** Names of the entities an endpoint serves, from `config.served_entities` (or the legacy `served_models`). */
export function servedEntityNames(config: Record<string, unknown>): string[] {
  const list = [
    ...((config["served_entities"] as Array<Record<string, unknown>> | undefined) ?? []),
    ...((config["served_models"] as Array<Record<string, unknown>> | undefined) ?? []),
  ];
  return [...new Set(list.map((e) => String(e["name"] ?? "")).filter((n) => n.length > 0))];
}

// ── Cluster events ──────────────────────────────────────────────────────────

export interface ClusterEvent {
  timestamp?: number;
  type?: string;
  details?: {
    current_num_workers?: number;
    target_num_workers?: number;
    user?: string;
    cause?: string;
    reason?: { code?: string; type?: string; parameters?: Record<string, string> };
    driver_state_message?: string;
    job_run_name?: string;
  };
}

const isoSeconds = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

/** One line per event, oldest first, in the shape `kubectl get events` users expect. */
export function clusterEventLines(events: ClusterEvent[]): string {
  const sorted = [...events].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  return sorted
    .map((e) => {
      const d = e.details ?? {};
      const parts: string[] = [];
      if (typeof d.current_num_workers === "number") parts.push(`workers=${d.current_num_workers}`);
      if (typeof d.target_num_workers === "number") parts.push(`target=${d.target_num_workers}`);
      if (d.cause) parts.push(`cause=${d.cause}`);
      if (d.reason?.code) parts.push(`reason=${d.reason.code}`);
      if (d.user) parts.push(`user=${d.user}`);
      if (d.job_run_name) parts.push(`run=${d.job_run_name}`);
      if (d.driver_state_message) parts.push(d.driver_state_message);
      const ts = e.timestamp ? isoSeconds(e.timestamp) : "?";
      return `${ts}  ${(e.type ?? "UNKNOWN").padEnd(22)}  ${parts.join("  ")}`.trimEnd() + "\n";
    })
    .join("");
}

/**
 * Worker count over time from the events that report it. A step series:
 * each point is the count from that event until the next one.
 */
export function clusterWorkerSeries(events: ClusterEvent[]): MetricSeries[] {
  const sorted = [...events]
    .filter((e) => typeof e.timestamp === "number")
    .sort((a, b) => a.timestamp! - b.timestamp!);
  const current = sorted
    .filter((e) => typeof e.details?.current_num_workers === "number")
    .map((e) => ({ timestamp: e.timestamp!, value: e.details!.current_num_workers! }));
  const target = sorted
    .filter((e) => typeof e.details?.target_num_workers === "number")
    .map((e) => ({ timestamp: e.timestamp!, value: e.details!.target_num_workers! }));
  const out: MetricSeries[] = [];
  if (current.length > 0) out.push({ label: "Workers", points: current });
  if (target.length > 0) out.push({ label: "Target workers", points: target });
  return out;
}

// ── system.compute.node_timeline ────────────────────────────────────────────

/** Cluster ids are `0123-456789-abcdefgh`; anything else never reaches SQL. */
export const CLUSTER_ID = /^[A-Za-z0-9-]+$/;

/** Bucket width that keeps a window to roughly 300 points, never under a minute. */
export function bucketSeconds(startMs: number, endMs: number): number {
  return Math.max(60, Math.ceil((endMs - startMs) / 1000 / 300 / 60) * 60);
}

/**
 * Per-bucket node utilisation for one cluster. CPU and memory are averaged
 * over every node (driver and workers) in the bucket; network is the total
 * across nodes divided by the bucket width, so it reads as a rate.
 */
export function nodeTimelineSql(
  clusterId: string,
  startMs: number,
  endMs: number,
  bucket: number,
): string {
  if (!CLUSTER_ID.test(clusterId)) throw new Error("Databricks plugin: invalid cluster id");
  const from = Math.floor(startMs / 1000);
  const to = Math.ceil(endMs / 1000);
  return `
    SELECT
      FLOOR(UNIX_TIMESTAMP(start_time) / ${bucket}) * ${bucket} AS bucket,
      AVG(cpu_user_percent + cpu_system_percent) AS cpu,
      AVG(cpu_wait_percent) AS cpu_wait,
      AVG(mem_used_percent) AS mem,
      SUM(network_sent_bytes) / ${bucket} AS net_out,
      SUM(network_received_bytes) / ${bucket} AS net_in
    FROM system.compute.node_timeline
    WHERE cluster_id = '${clusterId}'
      AND start_time >= FROM_UNIXTIME(${from})
      AND start_time < FROM_UNIXTIME(${to})
    GROUP BY 1
    ORDER BY 1`;
}

export function nodeTimelineSeries(columns: string[], rows: unknown[][]): MetricSeries[] {
  const index = new Map(columns.map((c, i) => [c, i]));
  const pick = (row: unknown[], key: string): number | null => {
    const i = index.get(key);
    if (i === undefined || row[i] === null || row[i] === undefined) return null;
    const n = Number(row[i]);
    return Number.isFinite(n) ? n : null;
  };
  const defs: Array<[string, string, string]> = [
    ["cpu", "CPU usage", "%"],
    ["cpu_wait", "CPU I/O wait", "%"],
    ["mem", "Memory used", "%"],
    ["net_in", "Network in", "bytes/s"],
    ["net_out", "Network out", "bytes/s"],
  ];
  const out: MetricSeries[] = [];
  for (const [key, label, unit] of defs) {
    const points: MetricSeries["points"] = [];
    for (const row of rows) {
      const ts = pick(row, "bucket");
      const value = pick(row, key);
      if (ts === null || value === null) continue;
      points.push({ timestamp: ts * 1000, value: round2(value) });
    }
    if (points.length > 0) out.push({ label, unit, points });
  }
  return out;
}

// ── SQL warehouse query history ─────────────────────────────────────────────

export interface QueryInfo {
  query_start_time_ms?: number;
  duration?: number;
  status?: string;
  metrics?: { read_bytes?: number; rows_produced_count?: number };
}

/**
 * Queries started per bucket, failures per bucket, mean duration of the
 * queries that finished, and bytes read. Buckets with no queries chart as
 * zero for the counts and are absent for the mean (an average of nothing is a
 * gap, not a zero).
 */
export function warehouseQuerySeries(
  queries: QueryInfo[],
  startMs: number,
  endMs: number,
): MetricSeries[] {
  const width = bucketSeconds(startMs, endMs) * 1000;
  const first = Math.floor(startMs / width) * width;
  const buckets = new Map<
    number,
    { count: number; failed: number; durSum: number; durN: number; read: number }
  >();
  for (let t = first; t < endMs; t += width) {
    buckets.set(t, { count: 0, failed: 0, durSum: 0, durN: 0, read: 0 });
  }
  for (const q of queries) {
    const start = q.query_start_time_ms;
    if (typeof start !== "number" || start < startMs || start >= endMs) continue;
    const b = buckets.get(Math.floor(start / width) * width);
    if (!b) continue;
    b.count += 1;
    if (q.status === "FAILED") b.failed += 1;
    if (q.status === "FINISHED" && typeof q.duration === "number") {
      b.durSum += q.duration;
      b.durN += 1;
    }
    b.read += q.metrics?.read_bytes ?? 0;
  }
  const entries = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
  return [
    { label: "Queries", points: entries.map(([t, b]) => ({ timestamp: t, value: b.count })) },
    {
      label: "Failed queries",
      points: entries.map(([t, b]) => ({ timestamp: t, value: b.failed })),
    },
    {
      label: "Avg query duration",
      unit: "ms",
      points: entries
        .filter(([, b]) => b.durN > 0)
        .map(([t, b]) => ({ timestamp: t, value: Math.round(b.durSum / b.durN) })),
    },
    {
      label: "Data read",
      unit: "bytes",
      points: entries.map(([t, b]) => ({ timestamp: t, value: b.read })),
    },
  ];
}

// ── Job runs ────────────────────────────────────────────────────────────────

export interface JobRun {
  start_time?: number;
  run_duration?: number;
  execution_duration?: number;
  setup_duration?: number;
  queue_duration?: number;
  end_time?: number;
  state?: { result_state?: string };
  status?: { termination_details?: { type?: string } };
}

/**
 * One point per run at its start time. `run_duration` is the multi-task
 * total; single-task runs report setup/execution/cleanup instead, so fall
 * back to end minus start. Seconds, since job runs are rarely sub-second.
 */
export function jobRunSeries(runs: JobRun[]): MetricSeries[] {
  const sorted = [...runs]
    .filter((r) => typeof r.start_time === "number" && r.start_time > 0)
    .sort((a, b) => a.start_time! - b.start_time!);
  const duration: MetricSeries["points"] = [];
  const queue: MetricSeries["points"] = [];
  const failed: MetricSeries["points"] = [];
  for (const r of sorted) {
    const ts = r.start_time!;
    const ms = r.run_duration || (r.end_time && r.end_time > ts ? r.end_time - ts : 0) || undefined;
    if (ms) duration.push({ timestamp: ts, value: round2(ms / 1000) });
    if (typeof r.queue_duration === "number") {
      queue.push({ timestamp: ts, value: round2(r.queue_duration / 1000) });
    }
    const result = r.state?.result_state;
    const type = r.status?.termination_details?.type;
    if (result || type) {
      // `result_state` is the older field and the precise one; the 2.2
      // `termination_details.type` is SUCCESS for every clean ending.
      const bad = result
        ? result === "FAILED" || result === "TIMEDOUT" || result === "UPSTREAM_FAILED"
        : type !== "SUCCESS";
      failed.push({ timestamp: ts, value: bad ? 1 : 0 });
    }
  }
  const out: MetricSeries[] = [];
  if (duration.length > 0) out.push({ label: "Run duration", unit: "s", points: duration });
  if (queue.length > 0) out.push({ label: "Queue time", unit: "s", points: queue });
  if (failed.length > 0) out.push({ label: "Failed runs", points: failed });
  return out;
}

// ── Pipeline event log ──────────────────────────────────────────────────────

export interface PipelineEvent {
  timestamp?: string;
  level?: string;
  event_type?: string;
  message?: string;
  origin?: { flow_name?: string; update_id?: string };
  error?: { exceptions?: Array<{ message?: string; class_name?: string }> };
}

export function pipelineEventLines(events: PipelineEvent[]): string {
  const sorted = [...events].sort((a, b) =>
    String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? "")),
  );
  return sorted
    .map((e) => {
      const ts = String(e.timestamp ?? "?")
        .replace("T", " ")
        .replace(/\.\d+Z?$/, "")
        .replace(/Z$/, "");
      const flow = e.origin?.flow_name ? ` [${e.origin.flow_name}]` : "";
      let line = `${ts}  ${(e.level ?? "INFO").padEnd(7)}  ${e.event_type ?? ""}${flow}  ${e.message ?? ""}`;
      for (const ex of e.error?.exceptions ?? []) {
        if (ex.message) line += `\n    ${ex.class_name ? `${ex.class_name}: ` : ""}${ex.message}`;
      }
      return line.trimEnd() + "\n";
    })
    .join("");
}
