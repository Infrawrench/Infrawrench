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
 * `project.id`, `currency`, `cost` (FLOAT), `credits[].amount`,
 * `credits[].type`, `sku.id`, and
 * `cost_at_list` (FLOAT, "Cost at list price per the default consumption
 * model", populated from 29 June 2023).
 *
 * `cost_at_list` becomes {@link CostRow.listAmount}, which is what lets a
 * managed service provider re-rate a customer's invoice to public pricing.
 * It is only reported for a group whose every export row carried it: a group
 * straddling the column's first day would otherwise list at a fraction of its
 * cost. An export table old enough to lack the column fails the query with
 * "Unrecognized name"; that is retried without it, so cost collection never
 * depends on a column that only feeds an optional feature.
 *
 * ─── Blended committed-use discounts ──────────────────────────────────────
 *
 * The blended basis (`CostRow.blendedAmount`, arithmetic in plugin-base's
 * `cost-blending.ts`) spreads each committed-use discount evenly over the
 * usage it was eligible to cover, instead of leaving it on the projects that
 * happened to be consuming when the commitment had headroom. The export says
 * which credits are CUDs through `credits.type`:
 *
 * - `COMMITTED_USAGE_DISCOUNT`: resource-based Compute Engine commitments,
 *   which are regional. Pool: `(day, currency, region)`.
 * - `COMMITTED_USAGE_DISCOUNT_DOLLAR_BASE`: spend-based commitments, which
 *   are not. Pool: `(day, currency)`.
 *
 * Eligible usage is every line item of a SKU that received that kind of CUD
 * credit on that day (in that region, for resource-based ones): the export
 * only credits SKUs a commitment can cover, so "this SKU got a CUD credit
 * today" is the provider's own statement of eligibility, and the same SKU's
 * uncovered hours are the usage that shared the commitment's scope without
 * getting any of it. Each line's weight is its `cost`, which is priced before
 * credits ("inclusive of negotiated discounts in your contract"), i.e. its
 * on-demand equivalent at the account's own rates.
 *
 * The pool's CUD credits are then re-split in proportion to weight, and each
 * row's blended amount is its net cost with its own CUD credits swapped for
 * its share. Commitment fees, other credit types (sustained use, promotions,
 * free tier) and ineligible SKUs are untouched, so every day sums to the same
 * net total. Spend-based CUDs on the newer model price covered usage at a
 * discounted consumption model and offset the fee with
 * `FEE_UTILIZATION_OFFSET` rather than crediting usage lines; that discount is
 * in the line's price, not in a credit, and is left as billed.
 * https://docs.cloud.google.com/billing/docs/how-to/export-data-bigquery-tables/standard-usage
 *
 * The richer query falls back to the plain one on any other 400 (an export
 * table old enough to lack `credits.type` or `sku.id`), so blending can never
 * cost an account its spend data. The two fallbacks are independent: a table
 * with CUD credit types but no `cost_at_list` still blends.
 */

import {
  allocateProportionally,
  CostSetupError,
  type CostFetchRange,
  type CostRow,
} from "@infrawrench/plugin-base";

export interface GcpCostContext {
  /** Project the query job runs in: needs `bigquery.jobUser`. */
  project: string;
  token: () => Promise<string>;
  /** Billing export table in `project.dataset.table` form; empty when unconfigured. */
  billingExportTable: string;
}

const BILLING_EXPORT_SETUP_URL =
  "https://cloud.google.com/billing/docs/how-to/export-data-bigquery";

/**
 * Console page where the export is turned on. It is billing-account-scoped
 * and the plugin only knows the project, so pass `project`: the console
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

/**
 * One grouped row of the query, before blending. The CUD columns are zero for
 * the fallback query, which does not select them.
 */
export interface GcpCostLine {
  row: CostRow;
  /** Σ `COMMITTED_USAGE_DISCOUNT` credits on the row (negative). */
  resourceCud: number;
  /** Σ `COMMITTED_USAGE_DISCOUNT_DOLLAR_BASE` credits on the row (negative). */
  spendCud: number;
  /** Σ `cost` of the row's line items eligible for a resource-based CUD. */
  resourceWeight: number;
  /** Σ `cost` of the row's line items eligible for a spend-based CUD. */
  spendWeight: number;
}

function num(raw: string): number {
  const n = Number(raw || "0");
  return Number.isFinite(n) ? n : 0;
}

function collectRows(page: BqQueryResponse, columns: string[], out: GcpCostLine[]): void {
  const dayIdx = columns.indexOf("day");
  const serviceIdx = columns.indexOf("service");
  const regionIdx = columns.indexOf("region");
  const projectIdx = columns.indexOf("project_id");
  const currencyIdx = columns.indexOf("currency");
  const costIdx = columns.indexOf("net_cost");
  const listIdx = columns.indexOf("list_cost");
  const listMissingIdx = columns.indexOf("list_missing");
  const resourceCudIdx = columns.indexOf("cud_resource");
  const spendCudIdx = columns.indexOf("cud_spend");
  const resourceWeightIdx = columns.indexOf("weight_resource");
  const spendWeightIdx = columns.indexOf("weight_spend");

  for (const r of page.rows ?? []) {
    const date = cell(r, dayIdx);
    const amount = Number(cell(r, costIdx) || "0");
    if (!date || !Number.isFinite(amount)) continue;
    const line = {
      resourceCud: resourceCudIdx < 0 ? 0 : num(cell(r, resourceCudIdx)),
      spendCud: spendCudIdx < 0 ? 0 : num(cell(r, spendCudIdx)),
      resourceWeight: resourceWeightIdx < 0 ? 0 : num(cell(r, resourceWeightIdx)),
      spendWeight: spendWeightIdx < 0 ? 0 : num(cell(r, spendWeightIdx)),
    };
    // Skip rows with no money on any basis. A row whose net is zero because a
    // CUD credit covered it entirely still takes part in blending, so it is
    // kept while it carries a credit or an eligible weight.
    if (
      amount === 0 &&
      line.resourceCud === 0 &&
      line.spendCud === 0 &&
      line.resourceWeight === 0 &&
      line.spendWeight === 0
    ) {
      continue;
    }

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
    if (listIdx >= 0 && listMissingIdx >= 0 && Number(cell(r, listMissingIdx) || "1") === 0) {
      const list = Number(cell(r, listIdx));
      if (Number.isFinite(list)) row.listAmount = list;
    }
    out.push({ row, ...line });
  }
}

/**
 * Blend the CUD credits of every pool and return the final rows: see
 * "Blended committed-use discounts" in the module header. Pure.
 *
 * A pool whose credits cannot be split (no eligible weight) keeps its
 * credits where the export put them. Rows that end up with no money and no
 * blended share are dropped, per the cost contract's "skip zero rows".
 */
export function blendGcpLines(lines: readonly GcpCostLine[]): CostRow[] {
  const resourceShare = new Map<number, number>();
  const spendShare = new Map<number, number>();

  const blendPools = (
    keyOf: (l: GcpCostLine) => string,
    cud: (l: GcpCostLine) => number,
    weight: (l: GcpCostLine) => number,
    into: Map<number, number>,
  ) => {
    const pools = new Map<string, number[]>();
    lines.forEach((l, i) => {
      if (cud(l) === 0 && weight(l) === 0) return;
      const key = keyOf(l);
      const list = pools.get(key);
      if (list) list.push(i);
      else pools.set(key, [i]);
    });
    for (const indices of pools.values()) {
      const total = indices.reduce((s, i) => s + cud(lines[i]!), 0);
      if (total === 0) continue;
      const shares = allocateProportionally(
        total,
        indices.map((i) => weight(lines[i]!)),
      );
      if (!shares) continue;
      indices.forEach((i, j) => into.set(i, shares[j]!));
    }
  };

  blendPools(
    (l) => [l.row.date, l.row.currency, l.row.region ?? ""].join("\u0000"),
    (l) => l.resourceCud,
    (l) => l.resourceWeight,
    resourceShare,
  );
  blendPools(
    (l) => [l.row.date, l.row.currency].join("\u0000"),
    (l) => l.spendCud,
    (l) => l.spendWeight,
    spendShare,
  );

  const out: CostRow[] = [];
  lines.forEach((l, i) => {
    const r = resourceShare.get(i);
    const sp = spendShare.get(i);
    if (r === undefined && sp === undefined) {
      if (l.row.amount !== 0) out.push(l.row);
      return;
    }
    const blended =
      l.row.amount -
      (r === undefined ? 0 : l.resourceCud - r) -
      (sp === undefined ? 0 : l.spendCud - sp);
    if (l.row.amount === 0 && blended === 0) return;
    out.push({ ...l.row, blendedAmount: blended });
  });
  return out;
}

/** Which optional column groups the grouped query selects. */
interface GcpQueryOptions {
  /** The CUD credit and eligible-weight columns {@link blendGcpLines} needs. */
  blended: boolean;
  /** `cost_at_list` and its coverage count, for {@link CostRow.listAmount}. */
  list: boolean;
}

/**
 * The grouped query. With neither option this is the original query, byte for
 * byte, kept as the last fallback for export tables that predate both
 * `credits.type` and `cost_at_list`.
 */
function buildQuery(table: string, { blended, list }: GcpQueryOptions): string {
  if (!blended) {
    return (
      "SELECT DATE(usage_start_time) AS day, " +
      'IFNULL(service.description, "") AS service, ' +
      'IFNULL(location.region, "") AS region, ' +
      'IFNULL(project.id, "") AS project_id, ' +
      "currency, " +
      "SUM(cost) + SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)) AS net_cost" +
      (list
        ? ", SUM(cost_at_list) AS list_cost, COUNTIF(cost_at_list IS NULL) AS list_missing "
        : " ") +
      `FROM \`${table}\` ` +
      "WHERE DATE(usage_start_time) BETWEEN @from_date AND @to_date " +
      "GROUP BY day, service, region, project_id, currency " +
      "ORDER BY day"
    );
  }
  return (
    "WITH lines AS (SELECT DATE(usage_start_time) AS day, " +
    'IFNULL(service.description, "") AS service, ' +
    'IFNULL(location.region, "") AS region, ' +
    'IFNULL(project.id, "") AS project_id, ' +
    'currency, IFNULL(sku.id, "") AS sku_id, cost, ' +
    (list ? "cost_at_list, " : "") +
    "IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0) AS credits, " +
    "IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c " +
    "WHERE c.type = 'COMMITTED_USAGE_DISCOUNT'), 0) AS cud_resource, " +
    "IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c " +
    "WHERE c.type = 'COMMITTED_USAGE_DISCOUNT_DOLLAR_BASE'), 0) AS cud_spend " +
    `FROM \`${table}\` ` +
    "WHERE DATE(usage_start_time) BETWEEN @from_date AND @to_date), " +
    "resource_skus AS (SELECT DISTINCT day, region, currency, sku_id FROM lines " +
    "WHERE cud_resource != 0), " +
    "spend_skus AS (SELECT DISTINCT day, currency, sku_id FROM lines WHERE cud_spend != 0) " +
    "SELECT l.day AS day, l.service AS service, l.region AS region, " +
    "l.project_id AS project_id, l.currency AS currency, " +
    "SUM(l.cost) + SUM(l.credits) AS net_cost, " +
    (list
      ? "SUM(l.cost_at_list) AS list_cost, COUNTIF(l.cost_at_list IS NULL) AS list_missing, "
      : "") +
    "SUM(l.cud_resource) AS cud_resource, SUM(l.cud_spend) AS cud_spend, " +
    "SUM(IF(r.sku_id IS NULL, 0, l.cost)) AS weight_resource, " +
    "SUM(IF(s.sku_id IS NULL, 0, l.cost)) AS weight_spend " +
    "FROM lines l " +
    "LEFT JOIN resource_skus r ON r.day = l.day AND r.region = l.region " +
    "AND r.currency = l.currency AND r.sku_id = l.sku_id " +
    "LEFT JOIN spend_skus s ON s.day = l.day AND s.currency = l.currency " +
    "AND s.sku_id = l.sku_id " +
    "GROUP BY day, service, region, project_id, currency " +
    "ORDER BY day"
  );
}

/** Thrown for a 400 from the blended query, so the caller can fall back. */
class GcpQueryRejected extends Error {}

export async function fetchGcpCostData(
  ctx: GcpCostContext,
  range: CostFetchRange,
): Promise<CostRow[]> {
  const table = ctx.billingExportTable.trim();
  if (!table) {
    throw new CostSetupError(
      "GCP has no spend API. Costs come from the Cloud Billing “standard usage cost” " +
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

  // Each fallback drops only what an older export table can lack: a 400
  // naming `cost_at_list` drops the list-price columns (they feed re-rating
  // only), any other 400 drops the blending columns. The last attempt is the
  // original query, whose failure is a real error.
  let opts: GcpQueryOptions = { blended: true, list: true };
  for (;;) {
    const last = !opts.blended && !opts.list;
    try {
      return blendGcpLines(await runCostQuery(ctx, buildQuery(table, opts), range, !last));
    } catch (err) {
      if (!(err instanceof GcpQueryRejected)) throw err;
      opts =
        opts.list && (/cost_at_list/.test(err.message) || !opts.blended)
          ? { ...opts, list: false }
          : { ...opts, blended: false };
    }
  }
}

/**
 * Run one cost query to completion and collect its rows.
 *
 * Net cost = cost + credits (credit amounts are negative in the export), so
 * sustained-use/committed-use discounts and promotions are reflected the way
 * the invoice reflects them, rather than reporting gross list cost.
 * usage_start_time is a TIMESTAMP; DATE() buckets it in UTC, matching the
 * contract's UTC billing days. BETWEEN is inclusive on both ends, matching
 * CostFetchRange semantics.
 */
async function runCostQuery(
  ctx: GcpCostContext,
  query: string,
  range: CostFetchRange,
  rejectable: boolean,
): Promise<GcpCostLine[]> {
  const tok = await ctx.token();
  const headers = { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" };

  // jobs.query submits and (usually) returns the first page synchronously;
  // dates go through real query parameters, not string interpolation.
  const submit = (query: string) =>
    fetch(`${BQ_BASE}/projects/${ctx.project}/queries`, {
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

  const res = await submit(query);
  if (!res.ok) {
    const text = await res.text();
    if (rejectable && res.status === 400) throw new GcpQueryRejected(text);
    throw new Error(`GCP cost query failed ${res.status}: ${text}`);
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
  const lines: GcpCostLine[] = [];
  collectRows(page, columns, lines);

  // Follow pageToken across getQueryResults pages.
  let pageToken = page.pageToken;
  while (pageToken) {
    const r = await fetch(resultsUrl(pageToken), { headers });
    if (!r.ok) throw new Error(`GCP cost query page failed ${r.status}: ${await r.text()}`);
    const next = (await r.json()) as BqQueryResponse;
    collectRows(next, columns, lines);
    pageToken = next.pageToken;
  }

  return lines;
}
