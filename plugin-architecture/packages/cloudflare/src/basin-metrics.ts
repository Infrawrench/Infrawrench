/**
 * Metrics for Basin Pipelines and Basin Catalog, from the GraphQL Analytics
 * API datasets Cloudflare documents (verified 2026-10 at
 * developers.cloudflare.com/basin-pipelines/observability/metrics/ and
 * developers.cloudflare.com/basin-catalog/observability/metrics/):
 *
 *   - pipelinesOperatorAdaptiveGroups   sum { bytesIn recordsIn decodeErrors }
 *                                       dims pipelineId, streamId, datetimeHour
 *   - pipelinesSinkAdaptiveGroups       sum { bytesWritten recordsWritten filesWritten
 *                                       rowGroupsWritten uncompressedBytesWritten }
 *                                       dims pipelineId, sinkId, datetimeHour
 *   - pipelinesUserErrorsAdaptiveGroups count, dims pipelineId, errorType, datetimeHour
 *                                       (dropped events: missing_field, type_mismatch, ...)
 *   - r2CatalogDataOperationsAdaptiveGroups   count, sum { requestBodyBytes requestDurationMs }
 *                                       dims warehouseName, namespaceName, tableName, datetimeHour
 *   - r2CatalogTableMaintenanceAdaptiveGroups count, sum { filesProcessed filesOutput
 *                                       inputBytes outputBytes jobDurationMs }, dim success
 *
 * All are account-scoped (`accountTag`) and need Account Analytics Read. The
 * pipeline datasets only document an hourly bucket (`datetimeHour`), so
 * every window is bucketed hourly; the catalog datasets also offer
 * `datetimeFifteenMinutes`, used for windows under six hours.
 */
import type { MetricSeries } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./clients/shared.js";
import { parseTableExternalId } from "./clients/basin-catalog-client.js";

const GRAPHQL = "https://api.cloudflare.com/client/v4/graphql";

type Range = { startMs: number; endMs: number } | undefined;

function window(timeRange: Range): { from: string; to: string; fine: boolean } {
  const now = Date.now();
  const startMs = timeRange?.startMs ?? now - 24 * 3_600_000;
  const endMs = timeRange?.endMs ?? now;
  return {
    from: new Date(startMs).toISOString(),
    to: new Date(endMs).toISOString(),
    fine: endMs - startMs < 6 * 3_600_000,
  };
}

type Group = {
  count?: number;
  dimensions?: Record<string, unknown>;
  sum?: Record<string, number | undefined>;
};

/**
 * Run one GraphQL query and return each requested dataset's groups for the
 * first account. Any failure (missing scope, dataset not enabled) yields
 * empty arrays so the Metrics tab renders empty rather than erroring.
 */
async function queryAccountDatasets(
  api: CloudflareApi,
  query: string,
  variables: Record<string, unknown>,
  datasets: string[],
): Promise<Record<string, Group[]>> {
  const empty = Object.fromEntries(datasets.map((d) => [d, [] as Group[]]));
  let account: string;
  try {
    account = await api.getAccountId();
  } catch {
    return empty;
  }
  try {
    const res = await fetch(GRAPHQL, {
      method: "POST",
      headers: { Authorization: `Bearer ${api.apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { account, ...variables } }),
    });
    if (!res.ok) return empty;
    const json = (await res.json()) as {
      data?: { viewer?: { accounts?: Array<Record<string, Group[] | undefined>> } };
    };
    const acc = json.data?.viewer?.accounts?.[0] ?? {};
    return Object.fromEntries(datasets.map((d) => [d, acc[d] ?? []]));
  } catch {
    return empty;
  }
}

/** Sum a field across groups into per-bucket points, chronologically. */
function series(
  groups: Group[],
  label: string,
  unit: string,
  value: (g: Group) => number,
): MetricSeries {
  const m = new Map<number, number>();
  for (const g of groups) {
    const ts = new Date(String(g.dimensions?.["ts"] ?? "")).getTime();
    if (!Number.isFinite(ts)) continue;
    m.set(ts, (m.get(ts) ?? 0) + value(g));
  }
  return {
    label,
    unit,
    points: [...m.entries()]
      .sort(([a], [b]) => a - b)
      .map(([timestamp, v]) => ({ timestamp, value: v })),
  };
}

const sumOf = (key: string) => (g: Group) => Number(g.sum?.[key] ?? 0);
const countOf = (g: Group) => Number(g.count ?? 0);

function nonEmpty(list: MetricSeries[]): MetricSeries[] {
  return list.filter((s) => s.points.length > 0);
}

/** Dropped events split by error type (missing_field, type_mismatch, ...). */
function errorTypeSeries(groups: Group[]): MetricSeries[] {
  const byType = new Map<string, Group[]>();
  for (const g of groups) {
    const t = String(g.dimensions?.["errorType"] ?? "") || "other";
    byType.set(t, [...(byType.get(t) ?? []), g]);
  }
  return [...byType.entries()].map(([type, gs]) =>
    series(gs, `Dropped: ${type.replace(/_/g, " ")}`, "events", countOf),
  );
}

const OPERATOR_SUM = "sum { bytesIn recordsIn decodeErrors }";
const SINK_SUM = "sum { bytesWritten recordsWritten filesWritten uncompressedBytesWritten }";

export async function fetchPipelineMetrics(
  api: CloudflareApi,
  pipelineId: string,
  timeRange: Range,
): Promise<MetricSeries[]> {
  const { from, to } = window(timeRange);
  const query = `query P($account: String!, $id: String!, $from: Time!, $to: Time!) {
    viewer {
      accounts(filter: { accountTag: $account }) {
        pipelinesOperatorAdaptiveGroups(
          limit: 10000
          filter: { pipelineId: $id, streamId_neq: "", datetime_geq: $from, datetime_leq: $to }
        ) { dimensions { ts: datetimeHour } ${OPERATOR_SUM} }
        pipelinesSinkAdaptiveGroups(
          limit: 10000
          filter: { pipelineId: $id, datetime_geq: $from, datetime_leq: $to }
        ) { dimensions { ts: datetimeHour } ${SINK_SUM} }
        pipelinesUserErrorsAdaptiveGroups(
          limit: 10000
          filter: { pipelineId: $id, datetime_geq: $from, datetime_leq: $to }
        ) { count dimensions { ts: datetimeHour errorType } }
      }
    }
  }`;
  const d = await queryAccountDatasets(api, query, { id: pipelineId, from, to }, [
    "pipelinesOperatorAdaptiveGroups",
    "pipelinesSinkAdaptiveGroups",
    "pipelinesUserErrorsAdaptiveGroups",
  ]);
  const op = d["pipelinesOperatorAdaptiveGroups"] ?? [];
  const sink = d["pipelinesSinkAdaptiveGroups"] ?? [];
  const errs = d["pipelinesUserErrorsAdaptiveGroups"] ?? [];
  return nonEmpty([
    series(op, "Records Ingested", "rows", sumOf("recordsIn")),
    series(op, "Bytes Ingested", "bytes", sumOf("bytesIn")),
    series(op, "Decode Errors", "events", sumOf("decodeErrors")),
    series(sink, "Records Delivered", "rows", sumOf("recordsWritten")),
    series(sink, "Bytes Delivered", "bytes", sumOf("bytesWritten")),
    series(sink, "Files Written", "objects", sumOf("filesWritten")),
    series(errs, "Dropped Events", "events", countOf),
    ...errorTypeSeries(errs),
  ]);
}

export async function fetchStreamMetrics(
  api: CloudflareApi,
  streamId: string,
  timeRange: Range,
): Promise<MetricSeries[]> {
  const { from, to } = window(timeRange);
  const query = `query S($account: String!, $id: String!, $from: Time!, $to: Time!) {
    viewer {
      accounts(filter: { accountTag: $account }) {
        pipelinesOperatorAdaptiveGroups(
          limit: 10000
          filter: { streamId: $id, datetime_geq: $from, datetime_leq: $to }
        ) { dimensions { ts: datetimeHour } ${OPERATOR_SUM} }
      }
    }
  }`;
  const d = await queryAccountDatasets(api, query, { id: streamId, from, to }, [
    "pipelinesOperatorAdaptiveGroups",
  ]);
  const op = d["pipelinesOperatorAdaptiveGroups"] ?? [];
  return nonEmpty([
    series(op, "Records Ingested", "rows", sumOf("recordsIn")),
    series(op, "Bytes Ingested", "bytes", sumOf("bytesIn")),
    series(op, "Decode Errors", "events", sumOf("decodeErrors")),
  ]);
}

export async function fetchSinkMetrics(
  api: CloudflareApi,
  sinkId: string,
  timeRange: Range,
): Promise<MetricSeries[]> {
  const { from, to } = window(timeRange);
  const query = `query K($account: String!, $id: String!, $from: Time!, $to: Time!) {
    viewer {
      accounts(filter: { accountTag: $account }) {
        pipelinesSinkAdaptiveGroups(
          limit: 10000
          filter: { sinkId: $id, datetime_geq: $from, datetime_leq: $to }
        ) { dimensions { ts: datetimeHour } ${SINK_SUM} }
      }
    }
  }`;
  const d = await queryAccountDatasets(api, query, { id: sinkId, from, to }, [
    "pipelinesSinkAdaptiveGroups",
  ]);
  const sink = d["pipelinesSinkAdaptiveGroups"] ?? [];
  return nonEmpty([
    series(sink, "Records Delivered", "rows", sumOf("recordsWritten")),
    series(sink, "Bytes Delivered", "bytes", sumOf("bytesWritten")),
    series(sink, "Uncompressed Bytes", "bytes", sumOf("uncompressedBytesWritten")),
    series(sink, "Files Written", "objects", sumOf("filesWritten")),
  ]);
}

/**
 * Catalog request and maintenance metrics for a whole warehouse, or for one
 * table when `table` is given.
 */
export async function fetchCatalogMetrics(
  api: CloudflareApi,
  warehouseName: string,
  timeRange: Range,
  table?: { namespace: string; name: string },
): Promise<MetricSeries[]> {
  if (!warehouseName) return [];
  const { from, to, fine } = window(timeRange);
  const dim = fine ? "datetimeFifteenMinutes" : "datetimeHour";
  const tableFilter = table ? "namespaceName: $ns, tableName: $table," : "";
  const tableVars = table ? ", $ns: String!, $table: String!" : "";
  const query = `query C($account: String!, $warehouse: String!, $from: Time!, $to: Time!${tableVars}) {
    viewer {
      accounts(filter: { accountTag: $account }) {
        r2CatalogDataOperationsAdaptiveGroups(
          limit: 10000
          filter: { warehouseName: $warehouse, ${tableFilter} datetime_geq: $from, datetime_leq: $to }
        ) { count dimensions { ts: ${dim} httpStatus } sum { requestBodyBytes requestDurationMs } }
        r2CatalogTableMaintenanceAdaptiveGroups(
          limit: 10000
          filter: { warehouseName: $warehouse, ${tableFilter} datetime_geq: $from, datetime_leq: $to }
        ) { count dimensions { ts: ${dim} success } sum { filesProcessed filesOutput inputBytes outputBytes } }
      }
    }
  }`;
  const vars: Record<string, unknown> = { warehouse: warehouseName, from, to };
  if (table) {
    vars["ns"] = table.namespace;
    vars["table"] = table.name;
  }
  const d = await queryAccountDatasets(api, query, vars, [
    "r2CatalogDataOperationsAdaptiveGroups",
    "r2CatalogTableMaintenanceAdaptiveGroups",
  ]);
  const ops = d["r2CatalogDataOperationsAdaptiveGroups"] ?? [];
  const jobs = d["r2CatalogTableMaintenanceAdaptiveGroups"] ?? [];
  const failedOps = ops.filter((g) => Number(g.dimensions?.["httpStatus"] ?? 0) >= 400);
  const failedJobs = jobs.filter((g) => Number(g.dimensions?.["success"] ?? 1) === 0);
  // Average latency per bucket = total duration / request count.
  const latency = (() => {
    const total = series(ops, "", "", sumOf("requestDurationMs"));
    const counts = new Map(series(ops, "", "", countOf).points.map((p) => [p.timestamp, p.value]));
    return {
      label: "Avg Catalog Request Latency",
      unit: "ms",
      points: total.points.map((p) => {
        const n = counts.get(p.timestamp) ?? 0;
        return { timestamp: p.timestamp, value: n > 0 ? p.value / n : 0 };
      }),
    };
  })();
  return nonEmpty([
    series(ops, "Catalog Requests", "requests", countOf),
    series(failedOps, "Failed Catalog Requests", "requests", countOf),
    latency,
    series(jobs, "Maintenance Jobs", "events", countOf),
    series(failedJobs, "Failed Maintenance Jobs", "events", countOf),
    series(jobs, "Files Compacted", "objects", sumOf("filesProcessed")),
    series(jobs, "Bytes Compacted", "bytes", sumOf("inputBytes")),
  ]);
}

/** Metrics for a `basin-table` resource id's external id. */
export async function fetchTableMetrics(
  api: CloudflareApi,
  externalId: string,
  timeRange: Range,
): Promise<MetricSeries[]> {
  const ref = parseTableExternalId(externalId);
  if (!ref) return [];
  let account: string;
  try {
    account = await api.getAccountId();
  } catch {
    return [];
  }
  return fetchCatalogMetrics(api, `${account}_${ref.bucket}`, timeRange, {
    namespace: ref.namespace,
    name: ref.name,
  });
}
