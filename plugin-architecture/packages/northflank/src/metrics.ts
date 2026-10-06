import type { MetricSeries } from "@infrawrench/plugin-base";
import type { NfLogLine, NfMetricBlock } from "./types.js";

/** Default Metrics-tab window: the last six hours. */
export const METRICS_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * Metric types requested per workload kind. `requests`, `http4xx/5xx` only
 * exist for services with public HTTP ports; asking for them on a job or an
 * addon is harmless (the block comes back empty) but wasteful.
 */
export const SERVICE_METRICS = [
  "cpu",
  "memory",
  "networkIngress",
  "networkEgress",
  "requests",
  "http4xxResponses",
  "http5xxResponses",
  "tcpConnectionsOpen",
];
export const JOB_METRICS = ["cpu", "memory", "networkIngress", "networkEgress"];
export const ADDON_METRICS = ["cpu", "memory", "diskUsage", "networkIngress", "networkEgress"];

const LABELS: Record<string, string> = {
  cpu: "CPU",
  memory: "Memory",
  networkIngress: "Network in",
  networkEgress: "Network out",
  tcpConnectionsOpen: "Open TCP connections",
  diskUsage: "Disk used",
  requests: "Requests",
  http4xxResponses: "HTTP 4xx responses",
  http5xxResponses: "HTTP 5xx responses",
  bandwidth: "Bandwidth",
  bandwidthVolume: "Bandwidth volume",
};

const UNITS: Record<string, string> = {
  pct: "%",
  vCPU: "vCPU",
  mb: "MB",
  kbps: "kbps",
  rps: "req/s",
  count: "",
};

/**
 * Turn Northflank's per-container blocks into one series per metric:
 * containers (replicas) are summed per timestamp, which is what a
 * service-level chart means for every unit Northflank reports (vCPU, MB,
 * kbps, req/s, counts). A percentage is averaged instead, since summing
 * three replicas at 40% does not make 120%.
 */
export function metricBlocksToSeries(
  data: Record<string, NfMetricBlock | undefined>,
): MetricSeries[] {
  const out: MetricSeries[] = [];
  for (const [metricId, block] of Object.entries(data ?? {})) {
    if (!block?.values?.length) continue;
    const unitRaw = block.metricInfo?.metricUnit ?? "";
    const average = unitRaw === "pct";
    const sums = new Map<number, { total: number; n: number }>();
    for (const v of block.values) {
      for (const point of v.data ?? []) {
        const ts = Date.parse(point.ts ?? "");
        if (!Number.isFinite(ts) || typeof point.value !== "number") continue;
        const cur = sums.get(ts) ?? { total: 0, n: 0 };
        cur.total += point.value;
        cur.n += 1;
        sums.set(ts, cur);
      }
    }
    if (sums.size === 0) continue;
    const points = [...sums.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([timestamp, s]) => ({
        timestamp,
        value: Math.round((average ? s.total / s.n : s.total) * 1000) / 1000,
      }));
    const unit = UNITS[unitRaw] ?? unitRaw;
    out.push({
      label: LABELS[metricId] ?? metricId,
      ...(unit ? { unit } : {}),
      points,
    });
  }
  return out;
}

/** Render log lines as text, oldest first, one line each with its timestamp. */
export function logLinesToText(lines: NfLogLine[]): string {
  return lines
    .slice()
    .sort((a, b) => String(a.ts ?? "").localeCompare(String(b.ts ?? "")))
    .map((l) => {
      const text = typeof l.log === "string" ? l.log : JSON.stringify(l.log ?? "");
      const ts = String(l.ts ?? "")
        .replace("T", " ")
        .replace(/(\.\d+)?Z$/, "");
      const container = l.containerId ? ` [${l.containerId}]` : "";
      return `${ts}${container}  ${text.replace(/\n+$/, "")}\n`;
    })
    .join("");
}
