/**
 * Actual-spend collection via the Cloud Billing → BigQuery export.
 *
 * GCP has no cost/spend API: actual billed spend is only available through the
 * user-configured Cloud Billing "standard usage cost" export to BigQuery
 * (https://cloud.google.com/billing/docs/how-to/export-data-bigquery). The
 * account's optional `billingExportTable` credential points at that table in
 * `project.dataset.table` form; when it isn't configured, `fetchCostData`
 * throws a user-actionable error so the host surfaces it and backs off.
 *
 * The query runs as a BigQuery job in the account's configured project via
 * `jobs.query`, reusing the plugin's service-account OAuth token. IAM needed
 * by the service account:
 *   - `roles/bigquery.jobUser` on the account's project (to run the query job)
 *   - `roles/bigquery.dataViewer` on the dataset containing the billing
 *     export table (which may live in a different project)
 *
 * Standard usage cost export schema fields used (verified against
 * https://cloud.google.com/billing/docs/how-to/export-data-bigquery-tables):
 * `usage_start_time` (TIMESTAMP), `service.description`, `location.region`,
 * `project.id`, `currency`, `cost` (FLOAT), `credits[].amount`.
 */

import { CostSetupError, type CostFetchRange, type CostRow } from "@infrawrench/plugin-base";

export interface GcpCostContext {
  /** Project the query job runs in — needs `bigquery.jobUser`. */
  project: string;
  token: () => Promise<string>;
  /** Billing export table in `project.dataset.table` form; empty when unconfigured. */
  billingExportTable: string;
}

const BILLING_EXPORT_SETUP_URL =
  "https://cloud.google.com/billing/docs/how-to/export-data-bigquery";

/**
 * Console page where the export is turned on. It is billing-account-scoped
 * and the plugin only knows the project, so pass `project` — the console
 * resolves it to that project's linked billing account and otherwise falls
 * back to its billing-account chooser.
 */
function billingExportConsoleUrl(project: string): string {
  return `https://console.cloud.google.com/billing/export?project=${encodeURIComponent(project)}`;
}

/**
 * Table identifiers are interpolated into the SQL (BigQuery query parameters
 * cannot parameterize identifiers), so reject anything outside the safe
 * `project.dataset.table` character set before it goes near the query.
 * Backticks, whitespace and quotes are all excluded by construction.
 */
const TABLE_ID_RE = /^[\w.-]+\.[\w$]+\.[\w$]+$/;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const BQ_BASE = "https://bigquery.googleapis.com/bigquery/v2";

interface BqQueryResponse {
  jobComplete?: boolean;
  jobReference?: { projectId?: string; jobId?: string; location?: string };
  schema?: { fields?: Array<{ name?: string }> };
  rows?: Array<{ f: Array<{ v: unknown }> }>;
  pageToken?: string;
}

/** BigQuery cell values arrive as strings (or null); never String(null). */
function cell(row: { f: Array<{ v: unknown }> }, idx: number): string {
  const v = row.f[idx]?.v;
  return v == null ? "" : String(v);
}

function collectRows(page: BqQueryResponse, columns: string[], out: CostRow[]): void {
  const dayIdx = columns.indexOf("day");
  const serviceIdx = columns.indexOf("service");
  const regionIdx = columns.indexOf("region");
  const projectIdx = columns.indexOf("project_id");
  const currencyIdx = columns.indexOf("currency");
  const costIdx = columns.indexOf("net_cost");

  for (const r of page.rows ?? []) {
    const date = cell(r, dayIdx);
    const amount = Number(cell(r, costIdx) || "0");
    // Skip zero rows per the cost contract (and anything unparsable).
    if (!date || !Number.isFinite(amount) || amount === 0) continue;

    const projectId = cell(r, projectIdx);
    const row: CostRow = {
      date,
      service: cell(r, serviceIdx),
      // Global/unregionalized charges come back as "" (IFNULL in the query).
      region: cell(r, regionIdx),
      currency: cell(r, currencyIdx) || "USD",
      amount,
    };
    // The standard export carries no per-resource detail (that's the detailed
    // export's resource.name); project.id is the finest native identifier, so
    // it backs both the "resource" dimension and a `project` tag. Both are
    // derived from the same GROUP BY key, so same-day re-fetches always yield
    // identical dimension keys.
    if (projectId) {
      row.resourceId = projectId;
      row.tags = { project: projectId };
    }
    out.push(row);
  }
}

export async function fetchGcpCostData(
  ctx: GcpCostContext,
  range: CostFetchRange,
): Promise<CostRow[]> {
  const table = ctx.billingExportTable.trim();
  if (!table) {
    throw new CostSetupError(
      "GCP has no spend API — costs come from the Cloud Billing “standard usage cost” " +
        "export to BigQuery. Turn the export on, then paste its project.dataset.table into " +
        "the account's “Billing export table” field.",
      { label: "Enable billing export to BigQuery", url: billingExportConsoleUrl(ctx.project) },
    );
  }
  if (!TABLE_ID_RE.test(table)) {
    throw new CostSetupError(
      `The billing export table "${table}" is not a valid project.dataset.table ` +
        "identifier. Copy it from the export's BigQuery dataset and edit the account.",
      { label: "Billing export setup guide", url: BILLING_EXPORT_SETUP_URL },
    );
  }
  if (!ISO_DATE_RE.test(range.fromDate) || !ISO_DATE_RE.test(range.toDate)) {
    throw new Error(`GCP cost collection: invalid date range ${range.fromDate}..${range.toDate}`);
  }

  // Net cost = cost + credits (credit amounts are negative in the export), so
  // sustained-use/committed-use discounts and promotions are reflected the way
  // the invoice reflects them, rather than reporting gross list cost.
  // usage_start_time is a TIMESTAMP; DATE() buckets it in UTC, matching the
  // contract's UTC billing days. BETWEEN is inclusive on both ends, matching
  // CostFetchRange semantics.
  const query =
    "SELECT DATE(usage_start_time) AS day, " +
    'IFNULL(service.description, "") AS service, ' +
    'IFNULL(location.region, "") AS region, ' +
    'IFNULL(project.id, "") AS project_id, ' +
    "currency, " +
    "SUM(cost) + SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)) AS net_cost " +
    `FROM \`${table}\` ` +
    "WHERE DATE(usage_start_time) BETWEEN @from_date AND @to_date " +
    "GROUP BY day, service, region, project_id, currency " +
    "ORDER BY day";

  const tok = await ctx.token();
  const headers = { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" };

  // jobs.query submits and (usually) returns the first page synchronously;
  // dates go through real query parameters, not string interpolation.
  const res = await fetch(`${BQ_BASE}/projects/${ctx.project}/queries`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      query,
      useLegacySql: false,
      parameterMode: "NAMED",
      queryParameters: [
        {
          name: "from_date",
          parameterType: { type: "DATE" },
          parameterValue: { value: range.fromDate },
        },
        {
          name: "to_date",
          parameterType: { type: "DATE" },
          parameterValue: { value: range.toDate },
        },
      ],
      maxResults: 10000,
      timeoutMs: 30000,
    }),
  });
  if (!res.ok) {
    throw new Error(`GCP cost query failed ${res.status}: ${await res.text()}`);
  }
  let page = (await res.json()) as BqQueryResponse;

  const jobRef = page.jobReference;
  const resultsUrl = (pageToken?: string): string => {
    if (!jobRef?.jobId) {
      throw new Error("GCP cost query: BigQuery response is missing a job reference");
    }
    const params = new URLSearchParams({ maxResults: "10000", timeoutMs: "10000" });
    if (jobRef.location) params.set("location", jobRef.location);
    if (pageToken) params.set("pageToken", pageToken);
    return `${BQ_BASE}/projects/${ctx.project}/queries/${jobRef.jobId}?${params}`;
  };

  // Poll getQueryResults until the job completes (long queries return
  // jobComplete=false with no rows from the initial call).
  while (!page.jobComplete) {
    const r = await fetch(resultsUrl(), { headers });
    if (!r.ok) throw new Error(`GCP cost query poll failed ${r.status}: ${await r.text()}`);
    page = (await r.json()) as BqQueryResponse;
  }

  const columns = (page.schema?.fields ?? []).map((f) => String(f.name ?? ""));
  const rows: CostRow[] = [];
  collectRows(page, columns, rows);

  // Follow pageToken across getQueryResults pages.
  let pageToken = page.pageToken;
  while (pageToken) {
    const r = await fetch(resultsUrl(pageToken), { headers });
    if (!r.ok) throw new Error(`GCP cost query page failed ${r.status}: ${await r.text()}`);
    const next = (await r.json()) as BqQueryResponse;
    collectRows(next, columns, rows);
    pageToken = next.pageToken;
  }

  return rows;
}
