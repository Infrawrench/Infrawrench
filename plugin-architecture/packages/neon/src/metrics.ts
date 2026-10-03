/**
 * Usage charts for projects and branches from Neon's v2 consumption API
 * (`GET /consumption_history/v2/projects` and, per branch, the beta
 * `/consumption_history/v2/branches`; verified against the v2 OpenAPI spec,
 * October 2026). These are the metrics usage-based plans bill on.
 *
 * Organizations still on a legacy plan get no v2 data, so the project chart
 * falls back to the legacy `/consumption_history/projects` series. Its
 * storage figure (`synthetic_storage_size_bytes`) now always reads 0, so it
 * is no longer charted.
 *
 * Storage values are byte-months per timeframe; like `cost-data.ts`, they are
 * shown in binary gigabytes. The project chart also carries snapshot storage
 * and extra branch-months, which the per-branch endpoint does not report.
 */

import type { Api } from "@neondatabase/api-client";
import { ConsumptionHistoryGranularity } from "@neondatabase/api-client";
import type { MetricSeries } from "@infrawrench/plugin-base";

const BYTES_PER_GB = 2 ** 30;

/** v2 metric name → chart label, unit and conversion. */
const V2_METRICS: Array<{
  name: string;
  label: string;
  unit: string;
  convert: (value: number) => number;
}> = [
  { name: "compute_unit_seconds", label: "Compute", unit: "CU-h", convert: (v) => v / 3600 },
  {
    name: "root_branch_bytes_month",
    label: "Root Branch Storage",
    unit: "GB-month",
    convert: (v) => v / BYTES_PER_GB,
  },
  {
    name: "child_branch_bytes_month",
    label: "Child Branch Storage",
    unit: "GB-month",
    convert: (v) => v / BYTES_PER_GB,
  },
  {
    name: "instant_restore_bytes_month",
    label: "Instant Restore Storage",
    unit: "GB-month",
    convert: (v) => v / BYTES_PER_GB,
  },
  {
    name: "public_network_transfer_bytes",
    label: "Public Egress",
    unit: "bytes",
    convert: (v) => v,
  },
  {
    name: "private_network_transfer_bytes",
    label: "Private Transfer",
    unit: "bytes",
    convert: (v) => v,
  },
];

/**
 * Project-only v2 metrics: the per-branch endpoint rejects these two, so they
 * are asked of the project endpoint alone.
 */
const PROJECT_ONLY_METRICS: typeof V2_METRICS = [
  {
    name: "snapshot_storage_bytes_month",
    label: "Snapshot Storage",
    unit: "GB-month",
    convert: (v) => v / BYTES_PER_GB,
  },
  {
    name: "extra_branches_month",
    label: "Extra Branches",
    unit: "branch-months",
    convert: (v) => v,
  },
];

/** The branch endpoint accepts only the first six metrics, which these are. */
const METRIC_NAMES = V2_METRICS.map((m) => m.name);
const PROJECT_METRICS = [...V2_METRICS, ...PROJECT_ONLY_METRICS];

interface Timeframe {
  timeframe_start?: string | undefined;
  metrics?: Array<{ metric_name: string; value: number }> | undefined;
}

interface Window {
  from: string;
  to: string;
  granularity: ConsumptionHistoryGranularity;
}

/** Hourly data only covers the last 168 hours; anything wider is daily. */
function window(timeRange?: { startMs: number; endMs: number }): Window {
  const now = Date.now();
  const startMs = timeRange?.startMs ?? now - 24 * 3_600_000;
  const endMs = timeRange?.endMs ?? now;
  const hourly = now - startMs <= 168 * 3_600_000;
  return {
    from: new Date(startMs).toISOString(),
    to: new Date(endMs).toISOString(),
    granularity: hourly
      ? ConsumptionHistoryGranularity.Hourly
      : ConsumptionHistoryGranularity.Daily,
  };
}

function toSeries(timeframes: Timeframe[], metrics = V2_METRICS): MetricSeries[] {
  const out: MetricSeries[] = [];
  for (const metric of metrics) {
    const points = timeframes.flatMap((t) => {
      const entry = t.metrics?.find((m) => m.metric_name === metric.name);
      return entry && t.timeframe_start
        ? [{ timestamp: new Date(t.timeframe_start).getTime(), value: metric.convert(entry.value) }]
        : [];
    });
    if (points.length > 0 && points.some((p) => p.value !== 0)) {
      out.push({ label: metric.label, unit: metric.unit, points });
    }
  }
  return out;
}

export async function fetchProjectUsageSeries(
  api: Api<unknown>,
  orgId: string,
  projectId: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const w = window(timeRange);
  if (orgId) {
    try {
      const resp = await api.getConsumptionHistoryPerProjectV2({
        org_id: orgId,
        project_ids: [projectId],
        metrics: PROJECT_METRICS.map((m) => m.name),
        ...w,
      });
      const project = (resp.data.projects ?? []).find((p) => p.project_id === projectId);
      const timeframes = (project?.periods ?? []).flatMap((p) => p.consumption ?? []);
      if (timeframes.length > 0) return toSeries(timeframes, PROJECT_METRICS);
    } catch {
      /* legacy plan or an older key: try the legacy endpoint */
    }
  }
  return fetchLegacyProjectSeries(api, projectId, w);
}

export async function fetchBranchUsageSeries(
  api: Api<unknown>,
  orgId: string,
  projectId: string,
  branchId: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  if (!orgId) return [];
  const w = window(timeRange);
  try {
    const resp = await api.getConsumptionHistoryPerBranchV2({
      org_id: orgId,
      project_ids: [projectId],
      branch_ids: [branchId],
      metrics: METRIC_NAMES,
      ...w,
    });
    const branch = (resp.data.branches ?? []).find((b) => b.branch_id === branchId);
    const timeframes = (branch?.periods ?? []).flatMap((p) => p.consumption ?? []);
    if (timeframes.length > 0) return toSeries(timeframes);
  } catch {
    /* per-branch history is beta: fall back to the project's */
  }
  return fetchProjectUsageSeries(api, orgId, projectId, timeRange);
}

async function fetchLegacyProjectSeries(
  api: Api<unknown>,
  projectId: string,
  w: Window,
): Promise<MetricSeries[]> {
  try {
    const resp = await api.getConsumptionHistoryPerProject({
      project_ids: [projectId],
      from: w.from,
      to: w.to,
      granularity: w.granularity,
    });
    const project = (resp.data.projects ?? []).find((p) => p.project_id === projectId);
    const timeframes = (project?.periods ?? []).flatMap((p) => p.consumption ?? []);
    if (timeframes.length === 0) return [];
    const at = (t: { timeframe_start: string }) => new Date(t.timeframe_start).getTime();
    return [
      {
        label: "Active Time",
        unit: "s",
        points: timeframes.map((t) => ({ timestamp: at(t), value: t.active_time_seconds })),
      },
      {
        label: "Compute Time",
        unit: "s",
        points: timeframes.map((t) => ({ timestamp: at(t), value: t.compute_time_seconds })),
      },
      {
        label: "Data Written",
        unit: "bytes",
        points: timeframes.map((t) => ({ timestamp: at(t), value: t.written_data_bytes })),
      },
    ];
  } catch {
    return [];
  }
}
