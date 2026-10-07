/** Quotas (Nova, Cinder, Neutron limits) and Gnocchi metrics. */
import type { MetricSeries, QuotaUsage } from "@infrawrench/plugin-base";
import type { OpenStackClient } from "./client.js";
import { measuresToPoints } from "./mappers.js";

const NOVA: Array<[string, string, string, string]> = [
  ["instances", "Instances", "maxTotalInstances", "totalInstancesUsed"],
  ["cores", "vCPUs", "maxTotalCores", "totalCoresUsed"],
  ["ram", "RAM", "maxTotalRAMSize", "totalRAMUsed"],
  ["server_groups", "Server groups", "maxServerGroups", "totalServerGroupsUsed"],
];

const CINDER: Array<[string, string, string, string, string]> = [
  ["volumes", "Volumes", "maxTotalVolumes", "totalVolumesUsed", ""],
  ["gigabytes", "Volume storage", "maxTotalVolumeGigabytes", "totalGigabytesUsed", "GiB"],
  ["snapshots", "Snapshots", "maxTotalSnapshots", "totalSnapshotsUsed", ""],
  ["backups", "Backups", "maxTotalBackups", "totalBackupsUsed", ""],
  [
    "backup_gigabytes",
    "Backup storage",
    "maxTotalBackupGigabytes",
    "totalBackupGigabytesUsed",
    "GiB",
  ],
];

const NEUTRON_LABELS: Record<string, string> = {
  network: "Networks",
  subnet: "Subnets",
  port: "Ports",
  router: "Routers",
  floatingip: "Floating IPs",
  security_group: "Security groups",
  security_group_rule: "Security group rules",
  rbac_policy: "RBAC policies",
  subnetpool: "Subnet pools",
};

/**
 * Every figure is the cloud's own: Nova and Cinder `/limits` report
 * `max*`/`total*Used`, Neutron `quotas/{project}/details.json` reports
 * `{limit, used}`. A limit of -1 (unlimited) or 0 is not a quota and is
 * skipped. A service that is missing from the catalog contributes nothing;
 * one that is present but fails throws, so the host never stores a partial set.
 */
export async function fetchOpenStackQuotas(c: OpenStackClient): Promise<QuotaUsage[]> {
  const out: QuotaUsage[] = [];
  const region = c.api.region || undefined;
  const push = (
    service: string,
    key: string,
    name: string,
    limit: unknown,
    used: unknown,
    unit?: string,
  ) => {
    const l = Number(limit);
    const u = Number(used);
    if (!Number.isFinite(l) || l <= 0 || !Number.isFinite(u)) return;
    out.push({
      id: `${service}/${key}`,
      service,
      name,
      limit: l,
      used: u,
      ...(unit ? { unit } : {}),
      ...(region ? { region } : {}),
      adjustable: true,
    });
  };
  const nova = await c.api.get<{ limits?: { absolute?: Record<string, number> } }>(
    "compute",
    "/limits",
  );
  const abs = nova?.limits?.absolute ?? {};
  for (const [key, name, max, used] of NOVA)
    push(
      "compute",
      key,
      name,
      abs[max],
      abs[used],
      key === "ram" ? "MiB" : key === "cores" ? "vCPUs" : undefined,
    );
  if (await c.api.hasService("block-storage")) {
    const cinder = await c.api.get<{ limits?: { absolute?: Record<string, number> } }>(
      "block-storage",
      "/limits",
    );
    const a = cinder?.limits?.absolute ?? {};
    for (const [key, name, max, used, unit] of CINDER)
      push("block-storage", key, name, a[max], a[used], unit || undefined);
  }
  const pid = await c.projectId();
  const neutron = await c.api.get<{ quota?: Record<string, { limit?: number; used?: number }> }>(
    "network",
    `/v2.0/quotas/${encodeURIComponent(pid)}/details.json`,
  );
  for (const [key, q] of Object.entries(neutron?.quota ?? {}))
    push("network", key, NEUTRON_LABELS[key] ?? key, q.limit, q.used);
  return out;
}

/**
 * Server metrics from Gnocchi (the `metric` service), when the cloud runs
 * Ceilometer + Gnocchi. CPU is the cumulative `cpu` counter (nanoseconds)
 * turned into utilisation with `rate:mean` over the granularity and the
 * vCPU count; memory is `memory.usage` (MB). Clouds without Gnocchi return
 * no series rather than an error.
 */
export async function fetchServerMetrics(
  c: OpenStackClient,
  serverId: string,
  range?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  if (!(await c.api.hasService("metric").catch(() => false))) return [];
  const now = Date.now();
  const start = new Date(range?.startMs ?? now - 3_600_000).toISOString();
  const stop = new Date(range?.endMs ?? now).toISOString();
  const resource = await c.api
    .get<{ metrics?: Record<string, string> }>(
      "metric",
      `/v1/resource/instance/${encodeURIComponent(serverId)}`,
    )
    .catch(() => undefined);
  const metrics = resource?.metrics ?? {};
  const server = (await c.servers().catch(() => [])).find((s) => s.id === serverId);
  const vcpus = server?.flavor?.vcpus ?? 1;
  const series: MetricSeries[] = [];
  const measures = async (id: string | undefined, aggregation: string) =>
    id
      ? await c.api
          .get<Array<[string, number, number]>>(
            "metric",
            `/v1/metric/${encodeURIComponent(id)}/measures`,
            { start, stop, aggregation },
          )
          .catch(() => [] as Array<[string, number, number]>)
      : [];
  const cpu = await measures(metrics["cpu"], "rate:mean");
  if (cpu.length) {
    series.push({
      label: "CPU Utilization",
      unit: "%",
      points: cpu
        .map(([ts, gran, v]) => ({
          timestamp: Date.parse(ts),
          value: (v / (gran * 1e9 * vcpus)) * 100,
        }))
        .filter((p) => Number.isFinite(p.timestamp) && Number.isFinite(p.value)),
    });
  }
  const mem = await measures(metrics["memory.usage"], "mean");
  if (mem.length) series.push({ label: "Memory Used", unit: "MB", points: measuresToPoints(mem) });
  return series;
}
