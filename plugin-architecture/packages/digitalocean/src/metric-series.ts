/**
 * DigitalOcean metric series (droplet CPU/memory/disk/bandwidth, managed
 * database load, DOKS node metrics and Spaces usage) read from DO's
 * `/v2/monitoring/metrics/*` Prometheus-shaped endpoints.
 */
import { type MetricSeries, type ResourceInstance } from "@infrawrench/plugin-base";
import { idSegment } from "./api.js";
import type { DoApi, DoResponse } from "./api.js";

/** What every `/v2/monitoring/metrics/*` family answers with. */
type MonitoringResponse = DoResponse<"monitoring_get_DropletCpuMetrics">;

/**
 * The agent usage fields this module reads. None of them are in the document,
 * which has `measurements` instead (#412).
 */
type AgentUsage = DoResponse<"genai_get_agent_usage">["usage"] & {
  usage?: Array<{
    start?: string;
    end?: string;
    tokens?: number | string;
    input_tokens?: number | string;
    output_tokens?: number | string;
  }>;
  total_tokens?: number | string;
  total_input_tokens?: number | string;
  total_output_tokens?: number | string;
  throughput_tokens_per_second?: number | string;
  latency_seconds?: number | string;
  time_to_first_token_seconds?: number | string;
};

/** The slice of `DigitalOceanClient` the metric fetchers need. */
export interface DoMetricContext {
  api: DoApi;
  getResource(typeId: string, resourceId: string, accountId: string): Promise<ResourceInstance>;
}

export async function fetchDoMetricSeries(
  ctx: DoMetricContext,
  resourceTypeId: string,
  resourceId: string,
  accountId: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const now = Date.now();
  const startUnix = Math.floor((timeRange?.startMs ?? now - 3_600_000) / 1000);
  const endUnix = Math.floor((timeRange?.endMs ?? now) / 1000);

  const start = String(startUnix);
  const end = String(endUnix);

  const fetchPromMetric = async (
    request: () => Promise<MonitoringResponse>,
    label: string,
    unit: string,
  ): Promise<MetricSeries | null> => {
    try {
      const resp = await request();
      const values = resp.data?.result?.[0]?.values ?? [];
      if (values.length === 0) return null;
      return {
        label,
        unit,
        points: values.map(([ts, val]) => ({
          timestamp: Number(ts) * 1000,
          value: Number(val),
        })),
      };
    } catch {
      return null;
    }
  };

  if (resourceTypeId === "droplet") {
    const resource = await ctx.getResource(resourceTypeId, resourceId, accountId);
    const dropletId = resource.externalId ?? resourceId.split(":").pop();
    if (!dropletId) return [];
    // Every droplet metric DO exposes: see
    // https://docs.digitalocean.com/reference/api/digitalocean/#tag/Monitoring
    // Bandwidth and filesystem metrics need extra query parameters; the rest
    // share the host_id+start+end shape. Memory/disk/filesystem/load metrics
    // require the DO Metrics Agent to be installed on the droplet: DO will
    // 404 those endpoints for droplets without the agent, which
    // `fetchPromMetric` swallows.
    const hostId = dropletId;
    const plain = [
      { name: "cpu", label: "CPU Utilization", unit: "%" },
      { name: "load_1", label: "Load (1m)", unit: "" },
      { name: "load_5", label: "Load (5m)", unit: "" },
      { name: "load_15", label: "Load (15m)", unit: "" },
      { name: "memory_total", label: "Memory Total", unit: "bytes" },
      { name: "memory_available", label: "Memory Available", unit: "bytes" },
      { name: "memory_free", label: "Memory Free", unit: "bytes" },
      { name: "memory_cached", label: "Memory Cached", unit: "bytes" },
      { name: "disk_read", label: "Disk Read", unit: "bytes/s" },
      { name: "disk_write", label: "Disk Write", unit: "bytes/s" },
      { name: "filesystem_size", label: "Filesystem Size", unit: "bytes" },
      { name: "filesystem_free", label: "Filesystem Free", unit: "bytes" },
    ] as const;
    const bandwidth = [
      { label: "Public In", iface: "public", direction: "inbound" },
      { label: "Public Out", iface: "public", direction: "outbound" },
      { label: "Private In", iface: "private", direction: "inbound" },
      { label: "Private Out", iface: "private", direction: "outbound" },
    ] as const;
    // Fan out in parallel: 16 metrics serially racks up real wall time.
    const series = await Promise.all([
      ...plain.map((m) =>
        fetchPromMetric(
          () =>
            ctx.api.get(`/monitoring/metrics/droplet/${m.name}`, {
              query: { host_id: hostId, start, end },
            }),
          m.label,
          m.unit,
        ),
      ),
      ...bandwidth.map((m) =>
        fetchPromMetric(
          () =>
            ctx.api.get("/monitoring/metrics/droplet/bandwidth", {
              query: { host_id: hostId, start, end, interface: m.iface, direction: m.direction },
            }),
          m.label,
          "bytes/s",
        ),
      ),
    ]);
    return series.filter((s): s is MetricSeries => s != null);
  }

  if (resourceTypeId === "doks-cluster") {
    const clusterId = resourceId.split(":").pop();
    if (!clusterId) return [];
    let dropletIds: string[];
    try {
      const cluster = await ctx.api.get(`/kubernetes/clusters/${idSegment(clusterId)}`);
      dropletIds = (cluster.kubernetes_cluster?.node_pools ?? [])
        .flatMap((pool) => pool.nodes ?? [])
        .map((n) => String(n.droplet_id ?? ""))
        .filter((id) => id.length > 0);
    } catch {
      return [];
    }
    if (dropletIds.length === 0) return [];

    // For each metric, fetch per-droplet series and sum (or average) across nodes.
    // CPU is a percentage so average; memory_free is bytes so sum; bandwidth is bytes/sec so sum.
    const metricDefs: Array<{
      label: string;
      unit: string;
      combine: "avg" | "sum";
      request: (hostId: string) => Promise<MonitoringResponse>;
    }> = [
      {
        label: "CPU Utilization (avg)",
        unit: "%",
        combine: "avg",
        request: (hostId) =>
          ctx.api.get("/monitoring/metrics/droplet/cpu", {
            query: { host_id: hostId, start, end },
          }),
      },
      {
        label: "Free Memory (sum)",
        unit: "bytes",
        combine: "sum",
        request: (hostId) =>
          ctx.api.get("/monitoring/metrics/droplet/memory_free", {
            query: { host_id: hostId, start, end },
          }),
      },
      {
        label: "Network In (sum)",
        unit: "bytes/s",
        combine: "sum",
        request: (hostId) =>
          ctx.api.get("/monitoring/metrics/droplet/bandwidth", {
            query: { host_id: hostId, start, end, interface: "public", direction: "inbound" },
          }),
      },
    ];
    const results: MetricSeries[] = [];
    for (const def of metricDefs) {
      const perDroplet = await Promise.all(
        dropletIds.map((id) => fetchPromMetric(() => def.request(id), def.label, def.unit)),
      );
      // Combine: bucket points by timestamp.
      const buckets = new Map<number, number[]>();
      for (const series of perDroplet) {
        if (!series) continue;
        for (const p of series.points) {
          const arr = buckets.get(p.timestamp) ?? [];
          arr.push(p.value);
          buckets.set(p.timestamp, arr);
        }
      }
      if (buckets.size === 0) continue;
      const merged = [...buckets.entries()]
        .sort(([a], [b]) => a - b)
        .map(([timestamp, values]) => ({
          timestamp,
          value:
            def.combine === "avg"
              ? values.reduce((s, v) => s + v, 0) / values.length
              : values.reduce((s, v) => s + v, 0),
        }));
      results.push({ label: def.label, unit: def.unit, points: merged });
    }
    return results;
  }

  if (resourceTypeId === "managed-database") {
    // DO managed-DB monitoring endpoints are engine-scoped:
    // `/v2/monitoring/metrics/database/{engine}/{metric}` with
    // `db_id` + `aggregate` + `start` + `end` query params.
    // Ref: https://docs.digitalocean.com/reference/pydo/reference/monitoring/get_database_mysql_cpu_usage/
    const resource = await ctx.getResource(resourceTypeId, resourceId, accountId);
    const dbId = resource.externalId ?? resourceId.split(":").pop();
    if (!dbId) return [];
    // Engine slug in URL is the full word: "pg" → "postgresql".
    const engineMap: Record<string, string> = {
      pg: "postgresql",
      mysql: "mysql",
      redis: "redis",
      valkey: "valkey",
      mongodb: "mongodb",
      kafka: "kafka",
      opensearch: "opensearch",
    };
    const engineSlug = engineMap[String(resource.fields["engine"] ?? "")] ?? "";
    if (!engineSlug) return [];
    const engine = idSegment(engineSlug);
    const metric = { db_id: dbId, aggregate: "avg", start, end };
    const span = { db_id: dbId, start, end };
    // DO's API reference documents the database metrics for MySQL only:
    // https://docs.digitalocean.com/reference/api/reference/monitoring/
    // The CPU/memory/disk/load quartet is still asked of every engine and
    // fetchPromMetric swallows the 404 from engines that don't publish it.
    // `load` requires `metric=load1|load5|load15`.
    const loadMetric = (load: "load1" | "load5" | "load15", label: string) =>
      fetchPromMetric(
        () =>
          ctx.api.get(`/monitoring/metrics/database/${engine}/load`, {
            query: { ...metric, metric: load },
          }),
        label,
        "",
      );
    const common = [
      fetchPromMetric(
        () => ctx.api.get(`/monitoring/metrics/database/${engine}/cpu_usage`, { query: metric }),
        "CPU Utilization",
        "%",
      ),
      fetchPromMetric(
        () => ctx.api.get(`/monitoring/metrics/database/${engine}/memory_usage`, { query: metric }),
        "Memory Used",
        "%",
      ),
      fetchPromMetric(
        () => ctx.api.get(`/monitoring/metrics/database/${engine}/disk_usage`, { query: metric }),
        "Disk Used",
        "%",
      ),
      loadMetric("load1", "Load (1m)"),
      loadMetric("load5", "Load (5m)"),
      loadMetric("load15", "Load (15m)"),
    ];
    // MySQL-only series. Schema-scoped table I/O (`schema_latency`,
    // `schema_throughput`) needs a schema name, so it is not charted here.
    const mysql =
      engineSlug === "mysql"
        ? [
            fetchPromMetric(
              () =>
                ctx.api.get("/monitoring/metrics/database/mysql/index_vs_sequential_reads", {
                  query: span,
                }),
              "Reads Using an Index",
              "%",
            ),
            ...(["select", "insert", "update", "delete"] as const).map((op) =>
              fetchPromMetric(
                () =>
                  ctx.api.get("/monitoring/metrics/database/mysql/op_rates", {
                    query: { db_id: dbId, metric: op, start, end },
                  }),
                `${op[0]!.toUpperCase()}${op.slice(1)}s/s`,
                "ops/s",
              ),
            ),
            fetchPromMetric(
              () =>
                ctx.api.get("/monitoring/metrics/database/mysql/threads_connected", {
                  query: span,
                }),
              "Threads Connected",
              "",
            ),
            fetchPromMetric(
              () =>
                ctx.api.get("/monitoring/metrics/database/mysql/threads_active", { query: span }),
              "Threads Active",
              "",
            ),
            fetchPromMetric(
              () =>
                ctx.api.get("/monitoring/metrics/database/mysql/threads_created_rate", {
                  query: span,
                }),
              "Threads Created",
              "threads/s",
            ),
          ]
        : [];
    const series = await Promise.all([...common, ...mysql]);
    return series.filter((s): s is MetricSeries => s != null);
  }

  if (resourceTypeId === "gen-ai-agent") {
    const agentUuid = resourceId.split(":").slice(2).join(":");
    if (!agentUuid) return [];
    const startIso = new Date(timeRange?.startMs ?? now - 3_600_000).toISOString();
    const stopIso = new Date(timeRange?.endMs ?? now).toISOString();
    try {
      const resp = await ctx.api.get(`/gen-ai/agents/${idSegment(agentUuid)}/usage`, {
        query: { start: startIso, stop: stopIso },
      });
      const usage: AgentUsage = resp.usage ?? {};
      const buckets = Array.isArray(usage.usage) ? usage.usage : [];

      // Convert a bucket array to a MetricSeries: DO returns one row per
      // sampling window with `start`/`end` ISO timestamps plus the token
      // counts. Use the window start as the chart x-coordinate.
      const bucketSeries = (
        label: string,
        unit: string,
        pick: (b: (typeof buckets)[number]) => string | number | undefined,
      ): MetricSeries | null => {
        const points = buckets
          .map((b) => {
            const ts = Date.parse(String(b.start ?? b.end ?? ""));
            if (!Number.isFinite(ts)) return null;
            const v = Number(pick(b));
            if (!Number.isFinite(v)) return null;
            return { timestamp: ts, value: v };
          })
          .filter((p): p is { timestamp: number; value: number } => p !== null);
        if (points.length === 0) return null;
        return { label, unit, points };
      };

      // For aggregate single-number stats DO returns alongside the bucket
      // series, emit a flat one-point line so the chart still renders.
      const flatSeries = (
        label: string,
        unit: string,
        raw: string | number | undefined,
      ): MetricSeries | null => {
        const v = Number(raw);
        if (!Number.isFinite(v)) return null;
        return { label, unit, points: [{ timestamp: now, value: v }] };
      };

      const series = [
        bucketSeries("Input tokens", "tokens", (b) => b.input_tokens),
        bucketSeries("Output tokens", "tokens", (b) => b.output_tokens),
        bucketSeries("Total tokens", "tokens", (b) => b.tokens),
        flatSeries("Throughput", "tokens/s", usage.throughput_tokens_per_second),
        flatSeries("Latency (avg)", "s", usage.latency_seconds),
        flatSeries("Time to first token (avg)", "s", usage.time_to_first_token_seconds),
      ].filter((s): s is MetricSeries => s != null);

      // If only the flat totals came back (no buckets), surface the
      // totals as one-point lines so the user sees something.
      if (buckets.length === 0) {
        const totals = [
          flatSeries("Total input tokens", "tokens", usage.total_input_tokens),
          flatSeries("Total output tokens", "tokens", usage.total_output_tokens),
          flatSeries("Total tokens", "tokens", usage.total_tokens),
        ].filter((s): s is MetricSeries => s != null);
        return [...totals, ...series];
      }
      return series;
    } catch {
      // /usage 404s for agents that have never received a request: that's
      // a legitimate empty state, not an error. The host renders an
      // empty-metrics message rather than failing the tab.
      return [];
    }
  }

  return [];
}
