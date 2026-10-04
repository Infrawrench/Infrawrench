/**
 * Cost collection for CircleCI, from the Usage API
 * (https://circleci.com/docs/api/v2/index.html#tag/Usage, verified 2026-10):
 *
 * - `POST /organizations/{org_id}/usage_export_job` with `{start, end}` starts
 *   an asynchronous export. `start` may be at most a year back and `end` at
 *   most 31 days after `start`.
 * - `GET …/usage_export_job/{id}` reports `state`
 *   (`created | processing | completed | failed`) and, once completed,
 *   `download_urls`: one or more presigned links to gzip-compressed CSV files
 *   with one row per job run and UPPERCASE headers.
 * - Both calls are limited to about 10 an hour per organization, so the
 *   collector polls with backoff and the manifest keeps the backfill to six
 *   months (seven exports).
 *
 * Each CSV row carries the job's project, resource class and executor, and
 * its credits split by kind (compute, Docker layer caching, storage, network,
 * IP ranges, leases, user seats). Rows are summed per day, kind, project,
 * resource class and executor, and priced at the credential's price per
 * credit. The API never reports money, so the manifest declares `estimated`.
 *
 * When the plan includes free credits each month, a day's credits are only
 * billable once the month-to-date total passes the allowance (the same
 * month-to-date differencing other usage-priced plugins use), which needs the
 * export to start on the 1st of the month.
 */

import type { CostFetchRange, CostRow } from "@infrawrench/plugin-base";
import { CostSetupError } from "@infrawrench/plugin-base";
import type { CircleContext } from "./api.js";
import { circleFetch, downloadExport, isPermissionError, statusOf } from "./api.js";
import { parseCsv } from "./csv.js";
import type { CircleRates } from "./rates.js";

const DAY_MS = 86_400_000;
/** An export may span at most 31 days. */
export const MAX_EXPORT_DAYS = 31;
/** And may start at most a year back; stay a few days inside it. */
export const MAX_EXPORT_HISTORY_DAYS = 360;

export const USAGE_API_DOCS = {
  label: "CircleCI Usage API",
  url: "https://circleci.com/docs/api/v2/index.html#tag/Usage",
};

/** Credit columns in the export, and the service each becomes. */
export const CREDIT_COLUMNS: Array<{ column: string; service: string }> = [
  { column: "COMPUTE_CREDITS", service: "Compute" },
  { column: "DLC_CREDITS", service: "Docker Layer Caching" },
  { column: "STORAGE_CREDITS", service: "Storage" },
  { column: "NETWORK_CREDITS", service: "Network" },
  { column: "IPRANGES_CREDITS", service: "IP Ranges" },
  { column: "LEASE_CREDITS", service: "Leases" },
  { column: "LEASE_OVERAGE_CREDITS", service: "Lease Overage" },
  { column: "USER_CREDITS", service: "Users" },
];
const OTHER_SERVICE = "Other";

export interface UsageExportJob {
  usage_export_job_id: string;
  state: "created" | "processing" | "completed" | "failed" | string;
  download_urls?: string[];
  error_reason?: string;
}

export interface ExportOptions {
  /** Waits between polls, in milliseconds. The last one repeats until `maxWaitMs`. */
  pollDelaysMs?: number[];
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_POLL_DELAYS_MS = [5_000, 10_000, 20_000, 30_000, 60_000, 120_000, 240_000];
const DEFAULT_MAX_WAIT_MS = 20 * 60_000;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function rateLimited(what: string): Error {
  return new Error(
    `CircleCI rate-limited the usage export (${what}). It allows about 10 exports an hour per organization; collection retries later.`,
  );
}

/**
 * Run one usage export for `[start, end)` and return its rows (all files,
 * merged). Throws on a failed export or when it does not finish in time.
 */
export async function runUsageExport(
  ctx: CircleContext,
  orgId: string,
  start: Date,
  end: Date,
  opts: ExportOptions = {},
): Promise<Array<Record<string, string>>> {
  const sleep = opts.sleep ?? defaultSleep;
  const delays = opts.pollDelaysMs ?? DEFAULT_POLL_DELAYS_MS;
  const maxWait = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const base = `/organizations/${encodeURIComponent(orgId)}/usage_export_job`;

  let job: UsageExportJob;
  try {
    job = await circleFetch<UsageExportJob>(ctx, base, {
      method: "POST",
      body: { start: start.toISOString(), end: end.toISOString() },
    });
  } catch (err) {
    if (statusOf(err) === 429) throw rateLimited("too many exports started");
    throw err;
  }

  let waited = 0;
  for (let attempt = 0; job.state !== "completed"; attempt++) {
    if (job.state === "failed") {
      throw new Error(
        `CircleCI usage export failed${job.error_reason ? `: ${job.error_reason}` : ""}`,
      );
    }
    if (waited >= maxWait) {
      throw new Error(
        "CircleCI's usage export did not finish in time. Collection retries later; large organizations can take several minutes per month of usage.",
      );
    }
    const delay = delays[Math.min(attempt, delays.length - 1)] ?? 60_000;
    await sleep(delay);
    waited += delay;
    try {
      job = await circleFetch<UsageExportJob>(
        ctx,
        `${base}/${encodeURIComponent(job.usage_export_job_id)}`,
      );
    } catch (err) {
      // A rate-limited poll is not a failed export: wait out the next step.
      if (statusOf(err) !== 429) throw err;
      if (waited >= maxWait) throw rateLimited("too many status checks");
    }
  }

  const rows: Array<Record<string, string>> = [];
  for (const url of job.download_urls ?? []) {
    rows.push(...parseCsv(await downloadExport(ctx, url)));
  }
  return rows;
}

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const round = (n: number, digits = 6) => Math.round(n * 10 ** digits) / 10 ** digits;

function num(raw: string | undefined): number {
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** The day a row is billed on: the job's run date, else its pipeline's. */
export function rowDate(row: Record<string, string>): string | undefined {
  const raw = row["JOB_RUN_DATE"] || row["JOB_RUN_STARTED_AT"] || row["PIPELINE_CREATED_AT"] || "";
  const date = raw.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
}

/** One summed cell: a day, a kind of credit, and the job's attribution. */
export interface CreditCell {
  date: string;
  service: string;
  project: string;
  resourceClass: string;
  executor: string;
  credits: number;
}

/** Sum export rows into cells keyed by day, kind, project, resource class and executor. */
export function aggregateCredits(rows: Array<Record<string, string>>): CreditCell[] {
  const cells = new Map<string, CreditCell>();
  const add = (base: Omit<CreditCell, "service" | "credits">, service: string, credits: number) => {
    if (credits <= 0) return;
    const key = [base.date, service, base.project, base.resourceClass, base.executor].join(
      "\u0000",
    );
    const cell = cells.get(key);
    if (cell) cell.credits += credits;
    else cells.set(key, { ...base, service, credits });
  };
  for (const row of rows) {
    const date = rowDate(row);
    if (!date) continue;
    const base = {
      date,
      project: row["PROJECT_NAME"] ?? "",
      resourceClass: row["RESOURCE_CLASS"] ?? "",
      executor: row["EXECUTOR"] ?? "",
    };
    let itemised = 0;
    for (const { column, service } of CREDIT_COLUMNS) {
      const credits = num(row[column]);
      itemised += credits;
      add(base, service, credits);
    }
    // Anything in the total that no known column explains (a credit kind
    // added after this was written) still costs money: keep it visible.
    const total = num(row["TOTAL_CREDITS"]);
    if (total - itemised > 1e-6) add(base, OTHER_SERVICE, total - itemised);
  }
  return [...cells.values()];
}

/**
 * Turn cells into priced cost rows for the days in `[from, to]`. With an
 * allowance, each day's billable credits are the month-to-date total above it
 * at the end of the day minus the same the day before, spread across that
 * day's cells in proportion to their credits; `cells` must then cover the
 * month from its 1st.
 */
export function priceCells(
  cells: CreditCell[],
  rates: CircleRates,
  from: string,
  to: string,
): CostRow[] {
  const perDay = new Map<string, number>();
  for (const c of cells) perDay.set(c.date, (perDay.get(c.date) ?? 0) + c.credits);
  const billableShare = new Map<string, number>();
  const byMonth = new Map<string, string[]>();
  for (const day of [...perDay.keys()].sort()) {
    const m = day.slice(0, 7);
    byMonth.set(m, [...(byMonth.get(m) ?? []), day]);
  }
  for (const days of byMonth.values()) {
    let cumulative = 0;
    for (const day of days) {
      const credits = perDay.get(day) ?? 0;
      const before = Math.max(0, cumulative - rates.includedCredits);
      cumulative += credits;
      const billable = Math.max(0, cumulative - rates.includedCredits) - before;
      billableShare.set(day, credits > 0 ? billable / credits : 0);
    }
  }
  const rows: CostRow[] = [];
  for (const c of cells) {
    if (c.date < from || c.date > to) continue;
    const tags: Record<string, string> = {};
    if (c.project) tags["project"] = c.project;
    if (c.resourceClass) tags["resource_class"] = c.resourceClass;
    if (c.executor) tags["executor"] = c.executor;
    rows.push({
      date: c.date,
      service: c.service,
      ...(Object.keys(tags).length > 0 ? { tags } : {}),
      currency: "USD",
      amount: round(c.credits * (billableShare.get(c.date) ?? 0) * rates.pricePerCredit),
      usageAmount: round(c.credits, 4),
      usageUnit: "Credits",
    });
  }
  return rows;
}

/** Export window for a cost chunk: whole days, `[start, end)`, clamped to what the API allows. */
export function exportWindow(
  range: CostFetchRange,
  rates: CircleRates,
  nowMs: number,
): { start: Date; end: Date } | undefined {
  const earliest = Date.parse(`${isoDate(nowMs - MAX_EXPORT_HISTORY_DAYS * DAY_MS)}T00:00:00Z`);
  const monthStart = `${range.fromDate.slice(0, 7)}-01`;
  const from = rates.includedCredits > 0 ? monthStart : range.fromDate;
  let start = Math.max(Date.parse(`${from}T00:00:00Z`), earliest);
  let end = Math.min(Date.parse(`${range.toDate}T00:00:00Z`) + DAY_MS, nowMs);
  if (end - start > MAX_EXPORT_DAYS * DAY_MS) start = end - MAX_EXPORT_DAYS * DAY_MS;
  // Whole minutes: the API rejects an `end` in the future.
  end = Math.floor(end / 60_000) * 60_000;
  if (end <= start) return undefined;
  return { start: new Date(start), end: new Date(end) };
}

/** Daily estimated cost rows for `range`, by kind of credit, tagged with project, resource class and executor. */
export async function fetchCircleCostData(
  ctx: CircleContext,
  orgId: string,
  rates: CircleRates,
  range: CostFetchRange,
  opts: ExportOptions & { nowMs?: number } = {},
): Promise<CostRow[]> {
  const nowMs = opts.nowMs ?? Date.now();
  const window = exportWindow(range, rates, nowMs);
  if (!window) return [];
  try {
    const rows = await runUsageExport(ctx, orgId, window.start, window.end, opts);
    return priceCells(aggregateCredits(rows), rates, range.fromDate, range.toDate);
  } catch (err) {
    if (isPermissionError(err)) {
      throw new CostSetupError(
        "CircleCI refused the usage export for this organization. Exports need a personal token whose user can see the organization's plan usage, normally an organization admin.",
        USAGE_API_DOCS,
      );
    }
    throw err;
  }
}
