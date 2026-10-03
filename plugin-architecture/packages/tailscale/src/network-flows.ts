// Network flow logs (GET /tailnet/{tailnet}/logging/network) turned into
// metric series and log lines. Each node reports its own traffic in roughly
// five-second windows, counted from its side; see
// https://tailscale.com/kb/1219/network-flow-logs. Premium and Enterprise
// tailnets only, kept for 30 days.

import type { MetricSeries } from "@infrawrench/plugin-base";
import type { ConnectionCounts, NetworkFlowLog } from "./api.js";

/** The Metrics tab's default window. A busy tailnet logs every node every few seconds. */
export const FLOW_METRICS_DEFAULT_RANGE_MS = 60 * 60 * 1000;

/**
 * The widest window one request may cover. The endpoint does not paginate,
 * so the whole range arrives in one response; a day of five-second windows
 * across a large tailnet is already a heavy one.
 */
export const FLOW_METRICS_MAX_RANGE_MS = 24 * 60 * 60 * 1000;

/** Flow logs are retained for 30 days. */
export const FLOW_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Roughly how many points each series is bucketed into. */
const BUCKETS = 60;

const KINDS = [
  { key: "virtualTraffic", label: "Tailnet", always: true },
  { key: "subnetTraffic", label: "Subnet", always: false },
  { key: "exitTraffic", label: "Exit node", always: false },
  { key: "physicalTraffic", label: "Physical", always: true },
] as const;

type Kind = (typeof KINDS)[number]["key"];

function sum(rows: ConnectionCounts[] | undefined, key: keyof ConnectionCounts): number {
  let total = 0;
  for (const row of rows ?? []) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value)) total += value;
  }
  return total;
}

/** Clamp a requested window to what the endpoint can answer. */
export function flowWindow(
  timeRange: { startMs: number; endMs: number } | undefined,
  nowMs = Date.now(),
): { startMs: number; endMs: number } {
  const endMs = Math.min(timeRange?.endMs ?? nowMs, nowMs);
  const startMs = Math.max(
    timeRange?.startMs ?? endMs - FLOW_METRICS_DEFAULT_RANGE_MS,
    endMs - FLOW_METRICS_MAX_RANGE_MS,
    nowMs - FLOW_LOG_RETENTION_MS,
  );
  return { startMs: Math.min(startMs, endMs - 60_000), endMs };
}

/**
 * Bucket flow logs into per-second rates. With `nodeId` the series are that
 * device's traffic; without it they are summed over every reporting device
 * (so a packet between two devices counts once as sent and once as
 * received) and gain a count of devices that reported traffic.
 */
export function flowSeries(
  logs: NetworkFlowLog[],
  window: { startMs: number; endMs: number },
  nodeId?: string,
): MetricSeries[] {
  const { startMs, endMs } = window;
  const bucketMs = Math.max(60_000, Math.ceil((endMs - startMs) / BUCKETS / 60_000) * 60_000);
  const count = Math.max(1, Math.ceil((endMs - startMs) / bucketMs));
  const blank = () => Array.from({ length: count }, () => 0);
  const bytes = Object.fromEntries(
    KINDS.map(({ key }) => [key, { tx: blank(), rx: blank() }]),
  ) as Record<Kind, { tx: number[]; rx: number[] }>;
  const seen = new Set<Kind>();
  const packets = { tx: blank(), rx: blank() };
  const nodes = Array.from({ length: count }, () => new Set<string>());

  for (const log of logs) {
    if (nodeId && log.nodeId !== nodeId) continue;
    // Attribute the window to when it started; `logged` trails it.
    const at = Date.parse(log.start ?? log.logged ?? "");
    if (!Number.isFinite(at) || at < startMs || at >= endMs) continue;
    const index = Math.floor((at - startMs) / bucketMs);
    if (log.nodeId) nodes[index]!.add(log.nodeId);
    for (const { key } of KINDS) {
      const rows = log[key];
      if (!rows?.length) continue;
      seen.add(key);
      bytes[key].tx[index]! += sum(rows, "txBytes");
      bytes[key].rx[index]! += sum(rows, "rxBytes");
    }
    packets.tx[index]! += sum(log.virtualTraffic, "txPkts");
    packets.rx[index]! += sum(log.virtualTraffic, "rxPkts");
  }

  const seconds = bucketMs / 1000;
  const rate = (label: string, unit: string, values: number[]): MetricSeries => ({
    label,
    unit,
    points: values.map((value, i) => ({
      timestamp: startMs + i * bucketMs,
      value: value / seconds,
    })),
  });
  const series: MetricSeries[] = [];
  for (const { key, label, always } of KINDS) {
    if (!always && !seen.has(key)) continue;
    series.push(rate(`${label} traffic sent`, "bytes/s", bytes[key].tx));
    series.push(rate(`${label} traffic received`, "bytes/s", bytes[key].rx));
  }
  series.push(rate("Tailnet packets sent", "packets/s", packets.tx));
  series.push(rate("Tailnet packets received", "packets/s", packets.rx));
  if (!nodeId) {
    series.push({
      label: "Devices reporting traffic",
      unit: "devices",
      points: nodes.map((set, i) => ({ timestamp: startMs + i * bucketMs, value: set.size })),
    });
  }
  return series;
}

/**
 * One line per connection in each log window: when, which device (on the
 * tailnet view), the traffic kind, the pair, and both directions. `names`
 * maps node ids and Tailscale IPs to hostnames so a line reads as devices.
 */
export function formatFlowLogs(
  logs: NetworkFlowLog[],
  names: Map<string, string>,
  nodeId?: string,
): string[] {
  const lines: string[] = [];
  const label = (endpoint: string | undefined) => {
    if (!endpoint) return "?";
    // `ip:port` or `[v6]:port`.
    const match = /^\[?([^\]]+?)\]?:(\d+)$/.exec(endpoint);
    const host = match ? names.get(match[1]!) : names.get(endpoint);
    return host && match ? `${host}:${match[2]}` : (host ?? endpoint);
  };
  for (const log of logs) {
    if (nodeId && log.nodeId !== nodeId) continue;
    const who = nodeId ? "" : ` ${names.get(log.nodeId ?? "") ?? log.nodeId ?? "?"}`;
    for (const { key, label: kind } of KINDS) {
      for (const row of log[key] ?? []) {
        lines.push(
          `${log.start ?? log.logged ?? ""}${who} ${kind.toLowerCase()} ${row.proto ?? ""} ${label(row.src)} -> ${label(row.dst)} tx ${row.txBytes ?? 0}B/${row.txPkts ?? 0}p rx ${row.rxBytes ?? 0}B/${row.rxPkts ?? 0}p`
            .replace(/ {2,}/g, " ")
            .trim(),
        );
      }
    }
  }
  return lines;
}
