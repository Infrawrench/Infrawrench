import type { CostRow, MetricSeries, MetricSeriesPoint } from "@infrawrench/plugin-base";
import type { AtlasContext } from "./api.js";
import { atlasRequest, enc, listAll, statusOf } from "./api.js";

/**
 * Cluster charts from process measurements
 * (`GET /groups/{groupId}/processes/{processId}/measurements`). A cluster is
 * several `mongod`/`mongos` processes; each series is combined across them
 * the way the question it answers needs: connections, operations and network
 * are summed (the cluster's total), CPU, memory, disk IOPS, query targeting
 * and replication lag take the busiest node (one hot node is the problem).
 *
 * The CPU and memory labels are load-bearing: the cluster type's
 * `rightsizing` declaration names them, and the oversized finder looks the
 * stored series up by label.
 */

export const DEFAULT_METRICS_WINDOW_MS = 24 * 60 * 60 * 1000;
export const COST_METRICS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export const CPU_SERIES = "CPU (normalized, max across nodes)";
export const MEMORY_SERIES = "Memory used (max across nodes)";

export interface TimeRange {
  startMs: number;
  endMs: number;
}

export function rangeOrDefault(range: TimeRange | undefined, windowMs: number): TimeRange {
  if (range) return range;
  const endMs = Date.now();
  return { startMs: endMs - windowMs, endMs };
}

export interface AtlasProcess {
  id?: string;
  hostname?: string;
  userAlias?: string;
  port?: number;
  typeName?: string;
  replicaSetName?: string;
}

/**
 * Processes of one cluster. Atlas host names are
 * `<cluster>-shard-00-00.<project-subdomain>.mongodb.net` (current clusters
 * keep that form in `userAlias` while the real hostname is opaque), and the
 * cluster's SRV string is `mongodb+srv://<cluster>.<project-subdomain>.mongodb.net`,
 * so a process belongs to the cluster when its alias starts with the SRV
 * label plus a dash and ends with the same subdomain.
 */
export function processesForCluster(
  processes: AtlasProcess[],
  standardSrv: string,
): AtlasProcess[] {
  const host = standardSrv.replace(/^mongodb(\+srv)?:\/\//, "").split(/[/?,]/)[0] ?? "";
  const dot = host.indexOf(".");
  if (dot <= 0) return [];
  const label = host.slice(0, dot).toLowerCase();
  const domain = host.slice(dot + 1).toLowerCase();
  return processes.filter((p) => {
    const names = [p.userAlias, p.hostname].filter(Boolean).map((n) => n!.toLowerCase());
    return names.some((n) => n.startsWith(`${label}-`) && n.endsWith(`.${domain}`));
  });
}

export function granularityFor(range: TimeRange): string {
  const span = range.endMs - range.startMs;
  if (span <= 6 * 3_600_000) return "PT1M";
  if (span <= 48 * 3_600_000) return "PT5M";
  if (span <= 31 * 86_400_000) return "PT1H";
  return "P1D";
}

interface Measurement {
  name?: string;
  units?: string;
  dataPoints?: Array<{ timestamp?: string; value?: number | null }>;
}

const FULL_SET = [
  "CONNECTIONS",
  "OPCOUNTER_QUERY",
  "OPCOUNTER_INSERT",
  "OPCOUNTER_UPDATE",
  "OPCOUNTER_DELETE",
  "OPCOUNTER_GETMORE",
  "OPCOUNTER_CMD",
  "SYSTEM_NORMALIZED_CPU_USER",
  "SYSTEM_NORMALIZED_CPU_KERNEL",
  "SYSTEM_MEMORY_USED",
  "STORAGE_READ_IOPS",
  "STORAGE_WRITE_IOPS",
  "OPLOG_SLAVE_LAG_MASTER_TIME",
  "NETWORK_BYTES_IN",
  "NETWORK_BYTES_OUT",
  "QUERY_TARGETING_SCANNED_OBJECTS_PER_RETURNED",
];

/** What every dedicated cluster reports; the fallback when Atlas rejects a name. */
const CORE_SET = [
  "CONNECTIONS",
  "OPCOUNTER_QUERY",
  "OPCOUNTER_INSERT",
  "OPCOUNTER_UPDATE",
  "OPCOUNTER_DELETE",
  "SYSTEM_NORMALIZED_CPU_USER",
  "SYSTEM_NORMALIZED_CPU_KERNEL",
  "OPLOG_SLAVE_LAG_MASTER_TIME",
];

async function measurementsFor(
  ctx: AtlasContext,
  groupId: string,
  processId: string,
  range: TimeRange,
): Promise<Measurement[]> {
  const path = `/api/atlas/v2/groups/${enc(groupId)}/processes/${enc(processId)}/measurements`;
  const query = (names: string[]) => `${path}?${names.map((m) => `m=${m}`).join("&")}`;
  const params = {
    granularity: granularityFor(range),
    start: new Date(range.startMs).toISOString().replace(/\.\d{3}Z$/, "Z"),
    end: new Date(range.endMs).toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
  try {
    const res = await atlasRequest<{ measurements?: Measurement[] }>(ctx, "GET", query(FULL_SET), {
      query: params,
    });
    return res?.measurements ?? [];
  } catch (err) {
    if (statusOf(err) !== 400) throw err;
    const res = await atlasRequest<{ measurements?: Measurement[] }>(ctx, "GET", query(CORE_SET), {
      query: params,
    });
    return res?.measurements ?? [];
  }
}

function toBytes(value: number, units: string | undefined): number {
  switch ((units ?? "").toUpperCase()) {
    case "KILOBYTES":
      return value * 1024;
    case "MEGABYTES":
      return value * 1024 ** 2;
    case "GIGABYTES":
      return value * 1024 ** 3;
    default:
      return value;
  }
}

type Combine = "sum" | "max";

/** Combine one named measurement across processes, point by point. */
function combine(
  perProcess: Measurement[][],
  names: string[],
  how: Combine,
  transform: (v: number, units?: string) => number = (v) => v,
): MetricSeriesPoint[] {
  // Per process, first add the named measurements together (e.g. user + kernel CPU).
  const byTs = new Map<number, number>();
  for (const measurements of perProcess) {
    const local = new Map<number, number>();
    for (const m of measurements) {
      if (!names.includes(m.name ?? "")) continue;
      for (const p of m.dataPoints ?? []) {
        if (typeof p.value !== "number" || !p.timestamp) continue;
        const ts = Date.parse(p.timestamp);
        if (!Number.isFinite(ts)) continue;
        local.set(ts, (local.get(ts) ?? 0) + transform(p.value, m.units));
      }
    }
    for (const [ts, v] of local) {
      const prev = byTs.get(ts);
      byTs.set(ts, prev === undefined ? v : how === "sum" ? prev + v : Math.max(prev, v));
    }
  }
  return [...byTs.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([timestamp, value]) => ({ timestamp, value }));
}

export async function clusterSeries(
  ctx: AtlasContext,
  groupId: string,
  standardSrv: string,
  range: TimeRange,
): Promise<MetricSeries[]> {
  if (!standardSrv) return [];
  const all = await listAll<AtlasProcess>(ctx, `/api/atlas/v2/groups/${enc(groupId)}/processes`);
  const procs = processesForCluster(all, standardSrv).filter((p) => p.id);
  if (procs.length === 0) return [];
  const perProcess = await Promise.all(
    procs.map((p) => measurementsFor(ctx, groupId, p.id!, range).catch(() => [] as Measurement[])),
  );
  const secondaries = perProcess.filter((_, i) => /SECONDARY/.test(procs[i]?.typeName ?? ""));
  const defs: Array<{
    label: string;
    unit?: string;
    names: string[];
    how: Combine;
    from?: Measurement[][];
    transform?: (v: number, units?: string) => number;
  }> = [
    {
      label: CPU_SERIES,
      unit: "%",
      names: ["SYSTEM_NORMALIZED_CPU_USER", "SYSTEM_NORMALIZED_CPU_KERNEL"],
      how: "max",
    },
    {
      label: MEMORY_SERIES,
      unit: "bytes",
      names: ["SYSTEM_MEMORY_USED"],
      how: "max",
      transform: toBytes,
    },
    { label: "Connections", names: ["CONNECTIONS"], how: "sum" },
    { label: "Queries", unit: "ops/s", names: ["OPCOUNTER_QUERY"], how: "sum" },
    { label: "Inserts", unit: "ops/s", names: ["OPCOUNTER_INSERT"], how: "sum" },
    { label: "Updates", unit: "ops/s", names: ["OPCOUNTER_UPDATE"], how: "sum" },
    { label: "Deletes", unit: "ops/s", names: ["OPCOUNTER_DELETE"], how: "sum" },
    { label: "Getmores", unit: "ops/s", names: ["OPCOUNTER_GETMORE"], how: "sum" },
    { label: "Commands", unit: "ops/s", names: ["OPCOUNTER_CMD"], how: "sum" },
    { label: "Disk read IOPS (max node)", unit: "IOPS", names: ["STORAGE_READ_IOPS"], how: "max" },
    {
      label: "Disk write IOPS (max node)",
      unit: "IOPS",
      names: ["STORAGE_WRITE_IOPS"],
      how: "max",
    },
    {
      label: "Replication lag (max secondary)",
      unit: "s",
      names: ["OPLOG_SLAVE_LAG_MASTER_TIME"],
      how: "max",
      from: secondaries.length > 0 ? secondaries : perProcess,
    },
    { label: "Network in", unit: "bytes/s", names: ["NETWORK_BYTES_IN"], how: "sum" },
    { label: "Network out", unit: "bytes/s", names: ["NETWORK_BYTES_OUT"], how: "sum" },
    {
      label: "Query targeting (scanned objects per returned, max node)",
      names: ["QUERY_TARGETING_SCANNED_OBJECTS_PER_RETURNED"],
      how: "max",
    },
  ];
  return defs
    .map((d) => ({
      label: d.label,
      ...(d.unit ? { unit: d.unit } : {}),
      points: combine(d.from ?? perProcess, d.names, d.how, d.transform),
    }))
    .filter((s) => s.points.length > 0);
}

/** Daily spend series out of cost rows: the total plus the largest services. */
export function spendSeries(rows: CostRow[], range: TimeRange, topServices = 6): MetricSeries[] {
  const startDay = new Date(range.startMs).toISOString().slice(0, 10);
  const endDay = new Date(range.endMs).toISOString().slice(0, 10);
  const inRange = rows.filter((r) => r.date >= startDay && r.date <= endDay);
  const total = new Map<string, number>();
  const byService = new Map<string, Map<string, number>>();
  const serviceTotals = new Map<string, number>();
  for (const r of inRange) {
    total.set(r.date, (total.get(r.date) ?? 0) + r.amount);
    const service = r.service ?? "Other";
    serviceTotals.set(service, (serviceTotals.get(service) ?? 0) + r.amount);
    const m = byService.get(service) ?? new Map<string, number>();
    m.set(r.date, (m.get(r.date) ?? 0) + r.amount);
    byService.set(service, m);
  }
  const toPoints = (m: Map<string, number>) =>
    [...m.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, value]) => ({
        timestamp: Date.parse(`${date}T00:00:00Z`),
        value: Math.round(value * 100) / 100,
      }));
  const top = [...serviceTotals.entries()]
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topServices)
    .map(([s]) => s);
  const out: MetricSeries[] = [];
  if (total.size > 0) out.push({ label: "Daily charges", unit: "USD", points: toPoints(total) });
  for (const s of top) {
    out.push({ label: `Daily charges: ${s}`, unit: "USD", points: toPoints(byService.get(s)!) });
  }
  return out;
}
