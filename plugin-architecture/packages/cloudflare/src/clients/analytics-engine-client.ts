/**
 * Workers Analytics Engine datasets, read through the SQL API.
 *
 * Verified 2026-10 at developers.cloudflare.com/analytics/analytics-engine/sql-api/
 * and .../sql-reference/statements/: `POST /accounts/{aid}/analytics_engine/sql`
 * with the SQL as the raw request body, Bearer auth with Account Analytics
 * Read. The default output format is JSON (`{ meta, data, rows }`), not the
 * usual `{ success, result }` envelope. `SHOW TABLES` lists datasets; a
 * dataset appears once a Worker binding has written to it, and there is no
 * API to create or delete one (that happens through the binding). Data is
 * kept for three months.
 */
import type { MetricSeries, ResourceInstance, SqlTableMeta } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { withAuthErrorHint } from "./shared.js";

const SCOPE = "Account · Account Analytics:Read";

/** The fixed columns every dataset table has (blob1-20, double1-20, index1, ...). */
export const ANALYTICS_ENGINE_COLUMNS: Array<{ name: string; type: string }> = [
  { name: "dataset", type: "String" },
  { name: "timestamp", type: "DateTime" },
  { name: "_sample_interval", type: "UInt32" },
  { name: "index1", type: "String" },
  ...Array.from({ length: 20 }, (_, i) => ({ name: `blob${i + 1}`, type: "String" })),
  ...Array.from({ length: 20 }, (_, i) => ({ name: `double${i + 1}`, type: "Float64" })),
];

interface AeJson {
  meta?: Array<{ name: string; type?: string }>;
  data?: Array<Record<string, unknown>>;
  rows?: number;
}

/** Statuses that mean the token lacks Account Analytics Read. */
class AnalyticsEngineHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Run SQL against the account's Analytics Engine. Returns the parsed JSON
 * output, or the raw text for non-JSON formats (`FORMAT TabSeparated`).
 */
export async function runAnalyticsEngineSql(
  api: CloudflareApi,
  sql: string,
): Promise<{ json: AeJson | null; text: string }> {
  const account_id = await api.getAccountId();
  const res = await fetch(`${api.baseUrl}/accounts/${account_id}/analytics_engine/sql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${api.apiToken}`, "Content-Type": "text/plain" },
    body: sql,
  });
  const text = await res.text();
  if (!res.ok) {
    // Errors come back as plain text or as a Cloudflare envelope.
    let msg = text.trim();
    try {
      const env = JSON.parse(text) as { errors?: Array<{ message?: string }> };
      const joined = (env.errors ?? []).map((e) => e.message).filter(Boolean);
      if (joined.length > 0) msg = joined.join("; ");
    } catch {
      /* plain text */
    }
    throw new AnalyticsEngineHttpError(
      res.status,
      msg || `Analytics Engine SQL API returned status ${res.status}`,
    );
  }
  try {
    return { json: JSON.parse(text) as AeJson, text };
  } catch {
    return { json: null, text };
  }
}

/** Dataset names are SQL identifiers here; quote anything that isn't a plain one. */
export function datasetIdent(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

function mapDataset(name: string, accountId: string): ResourceInstance {
  const now = new Date().toISOString();
  return {
    id: `${accountId}:analytics-engine-dataset:${name}`,
    pluginId: "cloudflare",
    resourceTypeId: "analytics-engine-dataset",
    accountId,
    displayName: name,
    fields: { name },
    resolvedOutputs: { datasetName: name },
    secretStates: [],
    externalId: name,
    createdAt: now,
    updatedAt: now,
  };
}

/** Pull the dataset name out of a `SHOW TABLES` row, whatever the column is called. */
function datasetFromRow(row: Record<string, unknown>): string {
  for (const key of ["dataset", "name", "table"]) {
    if (typeof row[key] === "string" && row[key]) return row[key];
  }
  const first = Object.values(row).find((v) => typeof v === "string" && v);
  return typeof first === "string" ? first : "";
}

export async function listDatasetNames(api: CloudflareApi): Promise<string[]> {
  const { json } = await runAnalyticsEngineSql(api, "SHOW TABLES FORMAT JSON");
  return [...new Set((json?.data ?? []).map(datasetFromRow).filter(Boolean))].sort();
}

export async function listDatasets(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  return withAuthErrorHint(
    async () => {
      try {
        return (await listDatasetNames(api)).map((n) => mapDataset(n, accountId));
      } catch (err) {
        if (err instanceof AnalyticsEngineHttpError && (err.status === 401 || err.status === 403)) {
          // Re-shape so withAuthErrorHint recognises it as a permission failure.
          throw Object.assign(new Error(err.message), { status: err.status });
        }
        throw err;
      }
    },
    "Analytics Engine datasets",
    SCOPE,
  );
}

export async function executeAnalyticsEngineQuery(
  api: CloudflareApi,
  sql: string,
): Promise<{ rows: Record<string, unknown>[]; durationMs: number }> {
  const start = Date.now();
  const { json, text } = await runAnalyticsEngineSql(api, sql);
  const durationMs = Date.now() - start;
  if (!json) {
    // A non-JSON FORMAT: one row per output line so the result grid still renders.
    const rows = text
      .split("\n")
      .filter((l) => l.length > 0)
      .map((line) => ({ result: line }));
    return { rows, durationMs };
  }
  const order = (json.meta ?? []).map((m) => m.name);
  const rows = (json.data ?? []).map((r) => {
    if (order.length === 0) return r;
    const o: Record<string, unknown> = {};
    for (const k of order) o[k] = r[k] ?? null;
    return o;
  });
  return { rows, durationMs };
}

/** SQL editor metadata: every dataset, each with the fixed Analytics Engine columns. */
export async function introspectAnalyticsEngine(
  api: CloudflareApi,
  dataset: string,
): Promise<SqlTableMeta[]> {
  let names: string[];
  try {
    names = await listDatasetNames(api);
  } catch {
    names = [];
  }
  if (!names.includes(dataset)) names.unshift(dataset);
  return names.map((name) => ({ name, columns: ANALYTICS_ENGINE_COLUMNS }));
}

/** `2026-10-01 12:00:00` (UTC, as the SQL API prints DateTime) → epoch ms. */
function parseAeTime(v: unknown): number {
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  const s = String(v ?? "");
  const iso = s.includes("T") ? s : `${s.replace(" ", "T")}Z`;
  return Date.parse(iso);
}

/** `Date` → the `YYYY-MM-DD HH:MM:SS` form `toDateTime` accepts (UTC). */
function aeDateTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Metrics for a dataset, computed with SQL: data points written (sample
 * interval weighted, so it estimates the true count under sampling) and
 * stored rows, per hour (or per five minutes for windows under six hours).
 */
export async function fetchAnalyticsEngineMetrics(
  api: CloudflareApi,
  dataset: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  if (!dataset) return [];
  const now = Date.now();
  const startMs = timeRange?.startMs ?? now - 24 * 3_600_000;
  const endMs = timeRange?.endMs ?? now;
  const interval = endMs - startMs >= 6 * 3_600_000 ? "INTERVAL '1' HOUR" : "INTERVAL '5' MINUTE";
  const sql =
    `SELECT toStartOfInterval(timestamp, ${interval}) AS t, ` +
    `SUM(_sample_interval) AS points, count() AS stored ` +
    `FROM ${datasetIdent(dataset)} ` +
    `WHERE timestamp >= toDateTime('${aeDateTime(startMs)}') ` +
    `AND timestamp < toDateTime('${aeDateTime(endMs)}') ` +
    `GROUP BY t ORDER BY t FORMAT JSON`;
  let data: Array<Record<string, unknown>> = [];
  try {
    const { json } = await runAnalyticsEngineSql(api, sql);
    data = json?.data ?? [];
  } catch {
    return [];
  }
  const points: MetricSeries["points"] = [];
  const stored: MetricSeries["points"] = [];
  for (const row of data) {
    const ts = parseAeTime(row["t"]);
    if (!Number.isFinite(ts)) continue;
    points.push({ timestamp: ts, value: Number(row["points"] ?? 0) });
    stored.push({ timestamp: ts, value: Number(row["stored"] ?? 0) });
  }
  if (points.length === 0) return [];
  return [
    { label: "Data Points Written", unit: "events", points },
    { label: "Rows Stored (Sampled)", unit: "rows", points: stored },
  ];
}
