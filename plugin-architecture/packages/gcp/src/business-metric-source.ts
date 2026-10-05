/**
 * BigQuery as a business-metric source: a scheduled GoogleSQL query whose
 * rows (`day`, `value`, optional `label`) become a unit-cost denominator.
 *
 * Read-only is enforced by BigQuery itself, not only by the shared statement
 * check: every run first submits the bound statement as a dry-run job and
 * refuses unless `statistics.query.statementType` is `SELECT`, so a DML/DDL
 * statement or a multi-statement script never executes. The real query then
 * runs through `jobs.query` with a bytes-billed cap, a server-side job
 * timeout, and a row cap that throws instead of truncating.
 *
 * API reference:
 * - jobs.query: https://cloud.google.com/bigquery/docs/reference/rest/v2/jobs/query
 * - jobs.insert (dry run): https://cloud.google.com/bigquery/docs/reference/rest/v2/jobs/insert
 * - jobs.getQueryResults: https://cloud.google.com/bigquery/docs/reference/rest/v2/jobs/getQueryResults
 * - projects.list / datasets.list / tables.list for the pickers.
 */
import {
  assertBusinessMetricSql,
  bindBusinessMetricSqlRange,
  rowsToBusinessMetricPoints,
  withBusinessMetricTimeout,
  type BusinessMetricSourceDeclaration,
  type BusinessMetricSourceDryRun,
  type BusinessMetricSourceOption,
  type BusinessMetricSourceRange,
  type BusinessMetricSourceResult,
} from "@infrawrench/plugin-base";

const BQ_BASE = "https://bigquery.googleapis.com/bigquery/v2";

/** Bytes one scheduled run may bill before BigQuery fails it (without charge): 100 GiB. */
export const BIGQUERY_METRIC_MAX_BYTES_BILLED = 100 * 1024 ** 3;

/** Rows per results page; BigQuery also caps a page at 10 MB. */
const PAGE_SIZE = 10_000;

/** Longest a single jobs.query / getQueryResults call waits server-side. */
const POLL_WAIT_MS = 10_000;

/** Picker listings stop after this many pages, so a huge project cannot stall the form. */
const MAX_OPTION_PAGES = 10;

export const gcpBusinessMetricSource: BusinessMetricSourceDeclaration = {
  label: "BigQuery SQL",
  description:
    "Run a GoogleSQL query in BigQuery on a schedule. It must return one row per day with a `day` and a `value` column, plus an optional `label` column for a breakdown.",
  kind: "sql",
  sqlDialect: "GoogleSQL",
  readOnly: "enforced",
  supportsDryRun: true,
  fields: [
    {
      key: "project",
      label: "Project",
      type: "select",
      required: true,
      description:
        "The project the query runs and is billed in. The service account needs BigQuery Job User here and BigQuery Data Viewer on the data it reads.",
    },
    {
      key: "dataset",
      label: "Dataset",
      type: "select",
      required: true,
      dependsOn: ["project"],
      description:
        "Default dataset: table names in the query that are not qualified with a dataset resolve here.",
    },
    {
      key: "table",
      label: "Table",
      type: "select",
      dependsOn: ["project", "dataset"],
      description:
        "Optional. A helper to look up a table name for the query; it is not used when the query runs.",
    },
    {
      key: "sql",
      label: "Query",
      type: "sql",
      required: true,
      description:
        "A single SELECT returning `day`, `value` and optionally `label`. {{from}}, {{to}}, {{to_exclusive}} and {{timezone}} are replaced with quoted values for the import window. Each run is checked with a dry run first, may scan at most 100 GiB, and is refused unless BigQuery reports a SELECT.",
      placeholder:
        "SELECT DATE(created_at, {{timezone}}) AS day, COUNT(DISTINCT customer_id) AS value\nFROM orders\nWHERE DATE(created_at, {{timezone}}) BETWEEN {{from}} AND {{to}}\nGROUP BY day",
    },
  ],
};

export interface BigQueryMetricContext {
  /** The account's project, the fallback when no project is picked or listable. */
  project: string;
  token(): Promise<string>;
}

interface BqError {
  error?: { message?: string; errors?: Array<{ message?: string; reason?: string }> };
}

interface BqSchemaField {
  name?: string;
  type?: string;
}

interface BqQueryPage {
  jobComplete?: boolean;
  jobReference?: { projectId?: string; jobId?: string; location?: string };
  schema?: { fields?: BqSchemaField[] };
  rows?: Array<{ f?: Array<{ v?: unknown }> }>;
  totalRows?: string;
  pageToken?: string;
  totalBytesProcessed?: string;
  totalBytesBilled?: string;
  cacheHit?: boolean;
  errors?: Array<{ message?: string }>;
}

interface BqDryRunJob {
  statistics?: {
    query?: { statementType?: string; totalBytesProcessed?: string };
    totalBytesProcessed?: string;
  };
}

/** BigQuery's own message from an error body, or the raw text. */
function bigQueryErrorMessage(status: number, text: string): string {
  try {
    const body = JSON.parse(text) as BqError;
    const message = body.error?.message ?? body.error?.errors?.[0]?.message;
    if (message) return `BigQuery: ${message}`;
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return `BigQuery error ${status}: ${text.slice(0, 500)}`;
}

async function bq<T>(
  ctx: BigQueryMetricContext,
  url: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal | undefined } = {},
): Promise<T> {
  const tok = await ctx.token();
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${tok}`,
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : null,
    signal: init.signal ?? null,
  });
  if (!res.ok) throw new Error(bigQueryErrorMessage(res.status, await res.text()));
  return (await res.json()) as T;
}

async function listPaged<T>(
  ctx: BigQueryMetricContext,
  baseUrl: string,
  key: string,
): Promise<T[]> {
  const out: T[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_OPTION_PAGES; page++) {
    const url = new URL(baseUrl);
    url.searchParams.set("maxResults", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const body = await bq<Record<string, unknown>>(ctx, url.toString());
    const items = body[key];
    if (Array.isArray(items)) out.push(...(items as T[]));
    pageToken = typeof body["nextPageToken"] === "string" ? body["nextPageToken"] : undefined;
    if (!pageToken) break;
  }
  return out;
}

function projectOf(ctx: BigQueryMetricContext, params: Record<string, string>): string {
  return params["project"]?.trim() || ctx.project;
}

function seg(value: string): string {
  return encodeURIComponent(value);
}

export async function listGcpBusinessMetricOptions(
  ctx: BigQueryMetricContext,
  fieldKey: string,
  params: Record<string, string>,
): Promise<BusinessMetricSourceOption[]> {
  if (fieldKey === "project") {
    let projects: Array<{
      id?: string;
      friendlyName?: string;
      projectReference?: { projectId?: string };
    }> = [];
    try {
      projects = await listPaged(ctx, `${BQ_BASE}/projects`, "projects");
    } catch {
      // Listing is a convenience; the account's own project always works.
      projects = [];
    }
    const options = new Map<string, BusinessMetricSourceOption>();
    for (const p of projects) {
      const id = p.projectReference?.projectId ?? p.id;
      if (!id) continue;
      const name = p.friendlyName?.trim();
      options.set(id, { id, label: name && name !== id ? `${name} (${id})` : id });
    }
    if (!options.has(ctx.project)) {
      options.set(ctx.project, {
        id: ctx.project,
        label: ctx.project,
        description: "Account project",
      });
    }
    return [...options.values()].sort((a, b) => a.label.localeCompare(b.label));
  }

  if (fieldKey === "dataset") {
    const project = projectOf(ctx, params);
    const datasets = await listPaged<{
      datasetReference?: { datasetId?: string };
      friendlyName?: string;
      location?: string;
    }>(ctx, `${BQ_BASE}/projects/${seg(project)}/datasets`, "datasets");
    return datasets
      .map((d) => d.datasetReference?.datasetId)
      .map((id, i) =>
        id
          ? {
              id,
              label: id,
              ...(datasets[i]?.location ? { description: datasets[i]!.location } : {}),
            }
          : null,
      )
      .filter((o): o is BusinessMetricSourceOption => o !== null)
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  if (fieldKey === "table") {
    const project = projectOf(ctx, params);
    const dataset = params["dataset"]?.trim();
    if (!dataset) return [];
    const tables = await listPaged<{ tableReference?: { tableId?: string }; type?: string }>(
      ctx,
      `${BQ_BASE}/projects/${seg(project)}/datasets/${seg(dataset)}/tables`,
      "tables",
    );
    return tables
      .filter((t) => t.tableReference?.tableId)
      .map((t) => ({
        id: t.tableReference!.tableId!,
        label: t.tableReference!.tableId!,
        ...(t.type ? { description: t.type.toLowerCase().replace(/_/g, " ") } : {}),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  return [];
}

interface PreparedQuery {
  project: string;
  dataset: string;
  sql: string;
}

function prepare(
  ctx: BigQueryMetricContext,
  params: Record<string, string>,
  range: BusinessMetricSourceRange,
): PreparedQuery {
  const raw = params["sql"] ?? "";
  // On every execution, not only when the importer was saved.
  assertBusinessMetricSql(raw);
  const dataset = params["dataset"]?.trim() ?? "";
  if (!dataset) throw new Error("Pick the dataset the query runs against.");
  return { project: projectOf(ctx, params), dataset, sql: bindBusinessMetricSqlRange(raw, range) };
}

async function dryRunJob(
  ctx: BigQueryMetricContext,
  q: PreparedQuery,
  signal?: AbortSignal,
): Promise<{ statementType: string; bytesProcessed: number | undefined }> {
  const job = await bq<BqDryRunJob>(ctx, `${BQ_BASE}/projects/${seg(q.project)}/jobs`, {
    method: "POST",
    signal,
    body: {
      configuration: {
        dryRun: true,
        query: {
          query: q.sql,
          useLegacySql: false,
          defaultDataset: { projectId: q.project, datasetId: q.dataset },
        },
      },
    },
  });
  const stats = job.statistics?.query;
  const bytes = Number(stats?.totalBytesProcessed ?? job.statistics?.totalBytesProcessed);
  return {
    statementType: stats?.statementType ?? "",
    bytesProcessed: Number.isFinite(bytes) ? bytes : undefined,
  };
}

function notSelectMessage(statementType: string): string {
  return `BigQuery reports this as a ${statementType || "non-query"} statement. An importer only runs SELECT queries.`;
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/** Turn BigQuery's `{f: [{v}]}` rows into records keyed by column name. */
export function bigQueryRowsToRecords(
  fields: BqSchemaField[],
  rows: Array<{ f?: Array<{ v?: unknown }> }>,
): Record<string, unknown>[] {
  return rows.map((row) => {
    const record: Record<string, unknown> = {};
    fields.forEach((field, i) => {
      let value = row.f?.[i]?.v ?? null;
      // Older responses (or a server ignoring timestampOutputFormat) carry a
      // TIMESTAMP as float seconds since the epoch.
      if (
        field.type === "TIMESTAMP" &&
        typeof value === "string" &&
        /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(value)
      ) {
        value = new Date(Number(value) * 1000).toISOString();
      }
      record[field.name ?? String(i)] = value;
    });
    return record;
  });
}

async function executeQuery(
  ctx: BigQueryMetricContext,
  q: PreparedQuery,
  range: BusinessMetricSourceRange,
): Promise<{ records: Record<string, unknown>[]; first: BqQueryPage }> {
  const deadline = Date.now() + range.timeoutMs;
  const remaining = () => Math.max(1_000, Math.min(POLL_WAIT_MS, deadline - Date.now()));
  const tooMany = () =>
    new Error(
      `The query returned more than ${range.maxRows} rows. Group by day in the query so it returns one row per day (and label).`,
    );
  const checkTotal = (page: BqQueryPage) => {
    if (page.totalRows !== undefined && Number(page.totalRows) > range.maxRows) throw tooMany();
  };
  const failOnErrors = (page: BqQueryPage) => {
    const err = page.errors?.[0]?.message;
    if (page.jobComplete && err) throw new Error(`BigQuery: ${err}`);
  };

  let page = await bq<BqQueryPage>(ctx, `${BQ_BASE}/projects/${seg(q.project)}/queries`, {
    method: "POST",
    signal: range.signal,
    body: {
      query: q.sql,
      useLegacySql: false,
      defaultDataset: { projectId: q.project, datasetId: q.dataset },
      timeoutMs: remaining(),
      jobTimeoutMs: String(range.timeoutMs),
      maxResults: Math.min(PAGE_SIZE, range.maxRows + 1),
      maximumBytesBilled: String(BIGQUERY_METRIC_MAX_BYTES_BILLED),
      formatOptions: { timestampOutputFormat: "ISO8601_STRING" },
      labels: { infrawrench: "business-metric-import" },
    },
  });
  const ref = page.jobReference;
  const resultsUrl = (pageToken?: string) => {
    if (!ref?.jobId) throw new Error("BigQuery did not return a job reference for the query.");
    const url = new URL(
      `${BQ_BASE}/projects/${seg(ref.projectId ?? q.project)}/queries/${seg(ref.jobId)}`,
    );
    if (ref.location) url.searchParams.set("location", ref.location);
    url.searchParams.set("maxResults", String(Math.min(PAGE_SIZE, range.maxRows + 1)));
    url.searchParams.set("timeoutMs", String(remaining()));
    url.searchParams.set("formatOptions.timestampOutputFormat", "ISO8601_STRING");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    return url.toString();
  };

  while (!page.jobComplete) {
    if (Date.now() >= deadline) {
      throw new Error(`BigQuery did not finish within ${Math.round(range.timeoutMs / 1000)}s.`);
    }
    page = { ...page, ...(await bq<BqQueryPage>(ctx, resultsUrl(), { signal: range.signal })) };
  }
  failOnErrors(page);
  checkTotal(page);

  const first = page;
  const fields = page.schema?.fields ?? [];
  const records = bigQueryRowsToRecords(fields, page.rows ?? []);
  let pageToken = page.pageToken;
  while (pageToken) {
    if (records.length > range.maxRows) throw tooMany();
    const next = await bq<BqQueryPage>(ctx, resultsUrl(pageToken), { signal: range.signal });
    records.push(...bigQueryRowsToRecords(fields, next.rows ?? []));
    pageToken = next.pageToken;
  }
  if (records.length > range.maxRows) throw tooMany();
  return { records, first };
}

export async function runGcpBusinessMetricSource(
  ctx: BigQueryMetricContext,
  params: Record<string, string>,
  range: BusinessMetricSourceRange,
): Promise<BusinessMetricSourceResult> {
  const q = prepare(ctx, params, range);
  return withBusinessMetricTimeout(
    (async () => {
      const dry = await dryRunJob(ctx, q, range.signal);
      if (dry.statementType !== "SELECT") throw new Error(notSelectMessage(dry.statementType));
      const { records, first } = await executeQuery(ctx, q, range);
      const points = rowsToBusinessMetricPoints(records, range.maxRows);
      const notes: string[] = [];
      const processed = Number(first.totalBytesProcessed);
      if (first.cacheHit) notes.push("Served from the BigQuery cache");
      else if (Number.isFinite(processed)) notes.push(`Scanned ${formatBytes(processed)}`);
      const billed = Number(first.totalBytesBilled);
      if (Number.isFinite(billed) && billed > 0) notes.push(`Billed ${formatBytes(billed)}`);
      notes.push(`${records.length} row${records.length === 1 ? "" : "s"}`);
      return { points, notes };
    })(),
    range,
  );
}

export async function dryRunGcpBusinessMetricSource(
  ctx: BigQueryMetricContext,
  params: Record<string, string>,
  range: BusinessMetricSourceRange,
): Promise<BusinessMetricSourceDryRun> {
  try {
    const q = prepare(ctx, params, range);
    const dry = await withBusinessMetricTimeout(dryRunJob(ctx, q, range.signal), range);
    if (dry.statementType !== "SELECT") {
      return {
        valid: false,
        message: notSelectMessage(dry.statementType),
        ...(dry.bytesProcessed !== undefined ? { bytesProcessed: dry.bytesProcessed } : {}),
      };
    }
    if (dry.bytesProcessed !== undefined && dry.bytesProcessed > BIGQUERY_METRIC_MAX_BYTES_BILLED) {
      return {
        valid: false,
        message: `The query would scan ${formatBytes(dry.bytesProcessed)}, over the 100 GiB a scheduled run may bill. Filter on a partition column or select fewer columns.`,
        bytesProcessed: dry.bytesProcessed,
      };
    }
    return {
      valid: true,
      message:
        dry.bytesProcessed !== undefined
          ? `Valid query. A run over this window would scan ${formatBytes(dry.bytesProcessed)}.`
          : "Valid query.",
      ...(dry.bytesProcessed !== undefined ? { bytesProcessed: dry.bytesProcessed } : {}),
    };
  } catch (err) {
    return { valid: false, message: err instanceof Error ? err.message : String(err) };
  }
}
