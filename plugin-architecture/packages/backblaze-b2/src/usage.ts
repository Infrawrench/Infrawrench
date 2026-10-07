import type { CostRow, MetricSeries } from "@infrawrench/plugin-base";
import { CostSetupError } from "@infrawrench/plugin-base";
import type { B2Api } from "./api.js";
import { statusOf } from "./api.js";
import type { B2File } from "./types.js";

/**
 * Usage from Backblaze's daily usage reports.
 *
 * B2 has no usage or billing endpoint for an ordinary account. What it has is
 * Usage Reports ("Usage Reports for Partner API Accounts and Groups",
 * backblaze.com/docs/cloud-storage-use-partner-api-reports, 2026-10): once
 * Backblaze enables them, a standalone account gets a bucket named
 * `b2-reports-{accountId}` with one folder per UTC day (`YYYY-MM-DD/`) holding
 * `usage.account-{accountId}.csv`, one row per bucket per day with
 * `storage_byte_hours`, `stored_gb`, `downloaded_bytes`, `uploaded_gb`,
 * `deleted_gb` and the four `api_txn_class_*` counts. That file is the only
 * per-bucket usage source there is, so it feeds both the metrics and the cost
 * estimate.
 *
 * The money is an estimate at list price (backblaze.com/cloud-storage/pricing
 * and /transaction-pricing, 2026-10): $6.95 per TB per 30-day period from
 * byte-hours with the first 10 GB free; downloads free up to three times the
 * month's average storage, then $0.01/GB; Class A, B and C calls free; Class D
 * $0.004 per 10,000 after 2,500 a day.
 */

export const PRICING_AS_OF = "2026-10-06";
export const STORAGE_USD_PER_TB_MONTH = 6.95;
const FREE_STORAGE_BYTES = 10e9;
const EGRESS_USD_PER_GB = 0.01;
const FREE_EGRESS_MULTIPLE = 3;
const CLASS_D_FREE_PER_DAY = 2500;
const CLASS_D_USD_PER_10K = 0.004;
/** Backblaze bills storage per 30-day period, so a TB-month is 720 TB-hours. */
const HOURS_PER_BILLING_MONTH = 720;

export function reportsBucketName(accountId: string): string {
  return `b2-reports-${accountId}`;
}

export interface UsageRow {
  date: string;
  bucketId: string;
  bucketName: string;
  location: string;
  storageByteHours: number;
  storedGb: number;
  downloadedBytes: number;
  uploadedGb: number;
  deletedGb: number;
  classA: number;
  classB: number;
  classC: number;
  classD: number;
}

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c !== "")) rows.push(row);
  return rows;
}

function num(v: string | undefined): number {
  const n = Number(v ?? "");
  return Number.isFinite(n) ? n : 0;
}

/** Parse one usage CSV, keyed by its header row so column order never matters. */
export function parseUsageCsv(text: string): UsageRow[] {
  const [header, ...rest] = parseCsv(text);
  if (!header) return [];
  const idx = new Map(header.map((h, i) => [h.trim().toLowerCase(), i]));
  const col = (r: string[], name: string) => {
    const i = idx.get(name);
    return i === undefined ? undefined : r[i];
  };
  const out: UsageRow[] = [];
  for (const r of rest) {
    const date = (col(r, "date") ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    out.push({
      date,
      bucketId: (col(r, "bucket_id") ?? "").trim(),
      bucketName: (col(r, "bucket_name") ?? "").trim(),
      location: (col(r, "reporting_location") ?? "").trim(),
      storageByteHours: num(col(r, "storage_byte_hours")),
      storedGb: num(col(r, "stored_gb")),
      downloadedBytes: num(col(r, "downloaded_bytes")),
      uploadedGb: num(col(r, "uploaded_gb")),
      deletedGb: num(col(r, "deleted_gb")),
      classA: num(col(r, "api_txn_class_a")),
      classB: num(col(r, "api_txn_class_b")),
      classC: num(col(r, "api_txn_class_c")),
      classD: num(col(r, "api_txn_class_d")),
    });
  }
  return out;
}

/** Months (`YYYY-MM`) touched by an inclusive date range. */
export function monthsBetween(fromDate: string, toDate: string): string[] {
  const out: string[] = [];
  let y = Number(fromDate.slice(0, 4));
  let m = Number(fromDate.slice(5, 7));
  const endY = Number(toDate.slice(0, 4));
  const endM = Number(toDate.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
    if (out.length > 60) break;
  }
  return out;
}

/** Reads (and briefly caches) the account's usage reports. */
export class UsageReports {
  private cache = new Map<string, { at: number; rows: Promise<UsageRow[]> }>();

  constructor(private readonly api: B2Api) {}

  /**
   * All usage rows for one month. Throws {@link CostSetupError} when the
   * reports bucket does not exist or this key cannot read it.
   */
  month(month: string): Promise<UsageRow[]> {
    const hit = this.cache.get(month);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.rows;
    const rows = this.loadMonth(month);
    this.cache.set(month, { at: Date.now(), rows });
    rows.catch(() => this.cache.delete(month));
    return rows;
  }

  private async reportsBucket(): Promise<{ id: string; name: string }> {
    const s = await this.api.getSession();
    const name = reportsBucketName(s.accountId);
    let found: Array<{ bucketId: string; bucketName: string }> = [];
    try {
      const res = await this.api.call<{
        buckets?: Array<{ bucketId: string; bucketName: string }>;
      }>("b2_list_buckets", { body: { accountId: s.accountId, bucketName: name } });
      found = res?.buckets ?? [];
    } catch (err) {
      if (statusOf(err) === 401 || statusOf(err) === 403) {
        throw new CostSetupError(
          `This application key cannot list the usage reports bucket ${name}. Give it read access to that bucket (listBuckets, listFiles and readFiles), or use a key that covers all buckets.`,
          { label: "Manage application keys", url: "https://secure.backblaze.com/app_keys.htm" },
        );
      }
      throw err;
    }
    const bucket = found.find((b) => b.bucketName === name);
    if (!bucket) {
      throw new CostSetupError(
        `Backblaze has not turned on usage reports for this account yet, so there is no ${name} bucket to read usage from. Ask Backblaze support to enable Usage Reports; spend appears the day after the first report lands.`,
        {
          label: "About usage reports",
          url: "https://www.backblaze.com/docs/cloud-storage-use-partner-api-reports",
        },
      );
    }
    return { id: bucket.bucketId, name: bucket.bucketName };
  }

  private async loadMonth(month: string): Promise<UsageRow[]> {
    const bucket = await this.reportsBucket();
    const files: B2File[] = [];
    let start: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = await this.api.call<{ files?: B2File[]; nextFileName?: string | null }>(
        "b2_list_file_names",
        {
          body: {
            bucketId: bucket.id,
            prefix: `${month}-`,
            maxFileCount: 1000,
            ...(start ? { startFileName: start } : {}),
          },
        },
      );
      files.push(...(res?.files ?? []));
      start = res?.nextFileName ?? undefined;
      if (!start) break;
    }
    const usageFiles = files.filter(
      (f) => f.action !== "folder" && /(^|\/)usage[^/]*\.csv$/i.test(f.fileName),
    );
    const s = await this.api.getSession();
    const out: UsageRow[] = [];
    for (const file of usageFiles) {
      const path = file.fileName.split("/").map(encodeURIComponent).join("/");
      const res = await this.api.raw(
        {
          url: `${s.downloadUrl}/file/${encodeURIComponent(bucket.name)}/${path}`,
          method: "GET",
          headers: { Authorization: s.token },
        },
        `download ${file.fileName}`,
      );
      out.push(...parseUsageCsv(res.body));
    }
    // A day can in principle be re-issued; keep the last row per bucket-day.
    const byKey = new Map<string, UsageRow>();
    for (const r of out) byKey.set(`${r.date}|${r.bucketId || r.bucketName}`, r);
    return [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date));
  }

  async range(fromDate: string, toDate: string): Promise<UsageRow[]> {
    const months = monthsBetween(fromDate, toDate);
    const all = (await Promise.all(months.map((m) => this.month(m)))).flat();
    return all.filter((r) => r.date >= fromDate && r.date <= toDate);
  }
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Price one month of usage rows at list. Storage per bucket-day from
 * byte-hours (free 10 GB shared across the day's buckets in proportion to
 * their byte-hours); the download overage for the month spread over the
 * bucket-days in proportion to bytes downloaded; Class D overage per day
 * spread by each bucket's share of that day's Class D calls.
 */
export function priceMonth(rows: UsageRow[]): CostRow[] {
  const out: CostRow[] = [];
  const byDay = new Map<string, UsageRow[]>();
  for (const r of rows) {
    const list = byDay.get(r.date) ?? [];
    list.push(r);
    byDay.set(r.date, list);
  }
  const days = byDay.size;
  const totalByteHours = rows.reduce((s, r) => s + r.storageByteHours, 0);
  const avgStoredBytes = days > 0 ? totalByteHours / (days * 24) : 0;
  const freeEgressBytes = FREE_EGRESS_MULTIPLE * avgStoredBytes;
  const totalDownloaded = rows.reduce((s, r) => s + r.downloadedBytes, 0);
  const overageBytes = Math.max(0, totalDownloaded - freeEgressBytes);
  const egressUsd = (overageBytes / 1e9) * EGRESS_USD_PER_GB;

  for (const [date, dayRows] of byDay) {
    const dayByteHours = dayRows.reduce((s, r) => s + r.storageByteHours, 0);
    const freeByteHours = Math.min(dayByteHours, FREE_STORAGE_BYTES * 24);
    const dayClassD = dayRows.reduce((s, r) => s + r.classD, 0);
    const classDUsd =
      (Math.max(0, dayClassD - CLASS_D_FREE_PER_DAY) / 10_000) * CLASS_D_USD_PER_10K;
    for (const r of dayRows) {
      const base = {
        date,
        currency: "USD",
        ...(r.location ? { region: r.location } : {}),
        ...(r.bucketId ? { resourceId: r.bucketId } : {}),
        ...(r.bucketName ? { tags: { bucket: r.bucketName } } : {}),
      };
      if (r.storageByteHours > 0) {
        const share = dayByteHours > 0 ? r.storageByteHours / dayByteHours : 0;
        const billable = r.storageByteHours - freeByteHours * share;
        out.push({
          ...base,
          service: "Storage",
          amount: round((billable / 1e12 / HOURS_PER_BILLING_MONTH) * STORAGE_USD_PER_TB_MONTH),
          usageAmount: round(r.storageByteHours / 1e9),
          usageUnit: "GB-Hours",
        });
      }
      if (r.downloadedBytes > 0) {
        const share = totalDownloaded > 0 ? r.downloadedBytes / totalDownloaded : 0;
        out.push({
          ...base,
          service: "Download",
          amount: round(egressUsd * share),
          usageAmount: round(r.downloadedBytes / 1e9),
          usageUnit: "GB",
        });
      }
      const calls = r.classA + r.classB + r.classC + r.classD;
      if (calls > 0) {
        const share = dayClassD > 0 ? r.classD / dayClassD : 0;
        out.push({
          ...base,
          service: "API transactions",
          amount: round(classDUsd * share),
          usageAmount: calls,
          usageUnit: "Requests",
        });
      }
    }
  }
  return out;
}

/** Cost rows for an inclusive range: whole months are priced, then trimmed. */
export async function fetchB2CostData(
  reports: UsageReports,
  fromDate: string,
  toDate: string,
): Promise<CostRow[]> {
  const out: CostRow[] = [];
  for (const month of monthsBetween(fromDate, toDate)) {
    const rows = await reports.month(month);
    out.push(...priceMonth(rows).filter((r) => r.date >= fromDate && r.date <= toDate));
  }
  return out;
}

export const DEFAULT_METRICS_WINDOW_MS = 30 * 86_400_000;

function dayStart(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

/** Daily usage series for one bucket (or every bucket when `bucketId` is undefined). */
export function usageSeries(rows: UsageRow[], bucketId?: string): MetricSeries[] {
  const picked = bucketId === undefined ? rows : rows.filter((r) => r.bucketId === bucketId);
  const byDay = new Map<string, UsageRow[]>();
  for (const r of picked) byDay.set(r.date, [...(byDay.get(r.date) ?? []), r]);
  const days = [...byDay.keys()].sort();
  const series = (label: string, unit: string, pick: (r: UsageRow) => number): MetricSeries => ({
    label,
    unit,
    points: days.map((d) => ({
      timestamp: dayStart(d),
      value: round(byDay.get(d)!.reduce((s, r) => s + pick(r), 0)),
    })),
  });
  return [
    series("Stored", "GB", (r) => r.storedGb),
    series("Downloaded", "GB", (r) => r.downloadedBytes / 1e9),
    series("Uploaded", "GB", (r) => r.uploadedGb),
    series("Deleted", "GB", (r) => r.deletedGb),
    series("Class B transactions", "requests", (r) => r.classB),
    series("Class C transactions", "requests", (r) => r.classC),
  ];
}
