import type { MetricSeries } from "@infrawrench/plugin-base";

/**
 * Metric series from one `INFO all` reply. INFO is a point-in-time reading,
 * so every series carries a single point; the host's own sampling of pinned
 * resources builds the trend. Used for a standalone Redis instance's Metrics
 * tab and, through `exposeMetricsToParent`, for managed databases that hand
 * their connection to this plugin (Redis Cloud).
 *
 * Fields used (Redis INFO reference): `instantaneous_ops_per_sec`,
 * `connected_clients`, `blocked_clients`, `used_memory`, `maxmemory`,
 * `evicted_keys`, `expired_keys`, `keyspace_hits`/`keyspace_misses`, the
 * `dbN:keys=` keyspace lines, and per-command `cmdstat_*` call counts and
 * `usec_per_call` for a call-weighted average command latency. Any field the
 * server (or a proxy in front of it) omits simply drops its series.
 */
export function infoSeries(info: Record<string, string>, timestamp: number): MetricSeries[] {
  const out: MetricSeries[] = [];
  const point = (label: string, value: number | undefined, unit?: string) => {
    if (value === undefined || !Number.isFinite(value)) return;
    out.push({
      label,
      ...(unit ? { unit } : {}),
      points: [{ timestamp, value: Math.round(value * 1000) / 1000 }],
    });
  };
  const num = (key: string): number | undefined => {
    const raw = info[key];
    if (raw === undefined || raw === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  point("Ops/sec", num("instantaneous_ops_per_sec"), "ops/s");
  point("Connected clients", num("connected_clients"));
  point("Blocked clients", num("blocked_clients"));
  const used = num("used_memory");
  point("Used memory", used !== undefined ? used / 1024 ** 2 : undefined, "MB");
  const max = num("maxmemory");
  if (used !== undefined && max) point("Memory used of maxmemory", (used / max) * 100, "%");
  point("Evicted keys (total)", num("evicted_keys"));
  point("Expired keys (total)", num("expired_keys"));
  const hits = num("keyspace_hits");
  const misses = num("keyspace_misses");
  if (hits !== undefined && misses !== undefined && hits + misses > 0) {
    point("Hit ratio", (hits / (hits + misses)) * 100, "%");
  }
  let keys = 0;
  let sawKeyspace = false;
  let calls = 0;
  let usec = 0;
  for (const [k, v] of Object.entries(info)) {
    if (/^db\d+$/.test(k)) {
      const m = /(?:^|,)keys=(\d+)/.exec(v);
      if (m) {
        keys += Number(m[1]);
        sawKeyspace = true;
      }
    } else if (k.startsWith("cmdstat_")) {
      const c = /(?:^|,)calls=(\d+)/.exec(v);
      const u = /(?:^|,)usec_per_call=([\d.]+)/.exec(v);
      if (c && u) {
        calls += Number(c[1]);
        usec += Number(c[1]) * Number(u[1]);
      }
    }
  }
  if (sawKeyspace || "keyspace_hits" in info) point("Keys", keys);
  if (calls > 0) point("Avg command latency (since restart)", usec / calls / 1000, "ms");
  return out;
}
