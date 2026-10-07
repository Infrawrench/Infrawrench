import type { CostRow, MetricSeries } from "@infrawrench/plugin-base";
import type { Utilization } from "./api.js";

/**
 * Wasabi spend is estimated from the Stats API's daily utilization records,
 * the way Wasabi's own "Calculating Charges Based on Bucket Utilization" page
 * does it: each record is one day, and the day costs
 * `(billable active GiB + billable deleted GiB) × the per-GiB-day rate`.
 * Billing is base-2 (1 TB = 1,024 GiB) and the per-day rate is the monthly
 * price over 30 days. Pay-as-you-go is $7.99/TB/month from the first billing
 * cycle on or after 2026-07-01 ("May 2026: Wasabi Pricing"), $6.99 before.
 * "Timed deleted storage" (objects deleted before the 90-day minimum) is
 * billed at the same rate; there are no egress or API request fees.
 */

export const PRICING_AS_OF = "2026-10-06";
const GIB = 1024 ** 3;

export function usdPerTbMonth(date: string): number {
  return date >= "2026-07-01" ? 7.99 : 6.99;
}

export function usdPerGibDay(date: string): number {
  return usdPerTbMonth(date) / 1024 / 30;
}

export function dayOf(u: Utilization): string {
  return (u.StartTime ?? "").slice(0, 10);
}

/**
 * Stats API bucket names have come back prefixed (`1.mybucket` in Wasabi's
 * own sample), so a record matches a bucket by exact name or by a `.name`
 * suffix.
 */
export function bucketMatches(record: string | undefined, bucket: string): boolean {
  if (!record) return false;
  return record === bucket || record.endsWith(`.${bucket}`);
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export function costRows(records: Utilization[], bucketNames: string[] = []): CostRow[] {
  const out: CostRow[] = [];
  for (const u of records) {
    const date = dayOf(u);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const rate = usdPerGibDay(date);
    const name = bucketNames.find((b) => bucketMatches(u.Bucket, b)) ?? u.Bucket ?? "";
    const base = {
      date,
      currency: "USD",
      ...(u.Region ? { region: u.Region } : {}),
      ...(name ? { resourceId: name, tags: { bucket: name } } : {}),
    };
    const active = (u.PaddedStorageSizeBytes ?? 0) + (u.MetadataStorageSizeBytes ?? 0);
    if (active > 0) {
      out.push({
        ...base,
        service: "Active storage",
        amount: round((active / GIB) * rate),
        usageAmount: round(active / GIB),
        usageUnit: "GiB-Days",
      });
    }
    const deleted = u.DeletedStorageSizeBytes ?? 0;
    if (deleted > 0) {
      out.push({
        ...base,
        service: "Timed deleted storage",
        amount: round((deleted / GIB) * rate),
        usageAmount: round(deleted / GIB),
        usageUnit: "GiB-Days",
      });
    }
  }
  return out;
}

export const DEFAULT_METRICS_WINDOW_MS = 30 * 86_400_000;

export function utilizationSeries(records: Utilization[]): MetricSeries[] {
  const byDay = new Map<string, Utilization[]>();
  for (const u of records) {
    const d = dayOf(u);
    if (d) byDay.set(d, [...(byDay.get(d) ?? []), u]);
  }
  const days = [...byDay.keys()].sort();
  const series = (label: string, unit: string, pick: (u: Utilization) => number): MetricSeries => ({
    label,
    unit,
    points: days.map((d) => ({
      timestamp: Date.parse(`${d}T00:00:00Z`),
      value: round(byDay.get(d)!.reduce((s, u) => s + pick(u), 0)),
    })),
  });
  return [
    series("Active storage", "GiB", (u) => (u.PaddedStorageSizeBytes ?? 0) / GIB),
    series("Deleted storage", "GiB", (u) => (u.DeletedStorageSizeBytes ?? 0) / GIB),
    series("Objects", "objects", (u) => u.NumBillableObjects ?? 0),
    series("Uploaded", "GiB", (u) => (u.UploadBytes ?? 0) / GIB),
    series("Downloaded", "GiB", (u) => (u.DownloadBytes ?? 0) / GIB),
    series("API calls", "requests", (u) => u.NumAPICalls ?? 0),
  ];
}

/** Estimated monthly cost of the latest day's storage. */
export function monthlyEstimate(u: Utilization | undefined): number | undefined {
  if (!u) return undefined;
  const date = dayOf(u);
  const bytes =
    (u.PaddedStorageSizeBytes ?? 0) +
    (u.DeletedStorageSizeBytes ?? 0) +
    (u.MetadataStorageSizeBytes ?? 0);
  return Math.round((bytes / GIB / 1024) * usdPerTbMonth(date) * 100) / 100;
}
