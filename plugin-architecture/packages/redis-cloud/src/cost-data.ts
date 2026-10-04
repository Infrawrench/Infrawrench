/**
 * Spend collection for Redis Cloud.
 *
 * **Billed data first.** `POST /cost-report` generates a FOCUS-format cost
 * report for at most 40 days (Owner, Viewer or Billing admin role). It is
 * asynchronous: the POST returns a task, the finished task's
 * `response.resource.costReportId` names the file, and
 * `GET /cost-report/{costReportId}` returns it; with `format: "json"` the
 * file is an array of FOCUS rows. Each row covers a charge period
 * (`ChargePeriodStart` inclusive, `ChargePeriodEnd` exclusive) that can span
 * many days: a Pro database's hours between two configuration changes, an
 * Essentials plan's month, a subscription's monthly network line. The row's
 * `BilledCost` is spread evenly over the period, by the share of each UTC
 * day it covers, and only days inside the requested range are written, so
 * adjacent chunks never count the same money twice.
 *
 * **Estimate only as a fallback.** When the key cannot generate reports (a
 * Logs viewer key, or the API refusing the request) the collector prices the
 * current inventory at list: Pro subscriptions from `/subscriptions/{id}/pricing`
 * (shard-hours × hourly price × 24), Essentials from the plan's monthly price
 * prorated by day. Those rows are written **for today only** (yesterday's
 * inventory is unknowable), tagged `costBasis: list-price-estimate`, and the
 * pass is flagged degraded so the host does not let the coarser rows replace
 * per-database billed rows from earlier passes.
 */
import type {
  CostChargeType,
  CostFetchRange,
  CostFetchResult,
  CostRow,
} from "@infrawrench/plugin-base";
import { CostSetupError } from "@infrawrench/plugin-base";
import type { RcTask, RedisCloudContext } from "./api.js";
import { TaskFailedError, rcFetch, statusOf, taskErrorText, waitForTask } from "./api.js";
import { HOURS_PER_MONTH } from "./mappers.js";
import type { RcEssentialsSubscription, RcPricing, RcProSubscription } from "./types.js";

/** The API refuses ranges longer than this. */
export const MAX_REPORT_DAYS = 40;

const DAY_MS = 86_400_000;

/** One FOCUS row as the JSON report spells it. Numeric columns may arrive as strings. */
export interface FocusRow {
  BilledCost?: number | string;
  EffectiveCost?: number | string;
  ListCost?: number | string;
  BillingCurrency?: string;
  ChargePeriodStart?: string;
  ChargePeriodEnd?: string;
  ChargeCategory?: string;
  ChargeDescription?: string;
  ConsumedQuantity?: number | string | null;
  ConsumedUnit?: string;
  PricingUnit?: string;
  RegionId?: string;
  RegionName?: string;
  ResourceId?: string | number;
  ResourceName?: string;
  ResourceType?: string;
  ServiceName?: string;
  Tags?: Record<string, string> | string | null;
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function ymd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function dayStart(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

/** Split an inclusive date range into inclusive windows of at most `maxDays`. */
export function splitRange(range: CostFetchRange, maxDays = MAX_REPORT_DAYS): CostFetchRange[] {
  const out: CostFetchRange[] = [];
  let start = dayStart(range.fromDate);
  const end = dayStart(range.toDate);
  while (start <= end) {
    const windowEnd = Math.min(end, start + (maxDays - 1) * DAY_MS);
    out.push({ fromDate: ymd(start), toDate: ymd(windowEnd) });
    start = windowEnd + DAY_MS;
  }
  return out;
}

function chargeType(category: string | undefined): CostChargeType {
  switch (String(category ?? "").toLowerCase()) {
    case "tax":
      return "tax";
    case "credit":
      return "credit";
    case "adjustment":
      return "adjustment";
    case "purchase":
      return "other";
    default:
      return "usage";
  }
}

function parseTags(raw: FocusRow["Tags"]): Record<string, string> {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
    } catch {
      return {};
    }
  }
  return raw;
}

/**
 * Service label for a row: the tier (`Redis Cloud Pro` / `Redis Cloud
 * Essentials`), with network lines kept apart because they are billed per
 * subscription rather than per database.
 */
function serviceOf(row: FocusRow): string {
  const base = row.ServiceName || "Redis Cloud";
  const unit = `${row.PricingUnit ?? ""} ${row.ConsumedUnit ?? ""}`.toLowerCase();
  if (unit.includes("network")) return `${base} Network`;
  if (/minimum/i.test(row.ChargeDescription ?? "")) return `${base} Minimum Charge`;
  return base;
}

/** Turn FOCUS rows into daily cost rows inside `range` (both ends inclusive). */
export function focusRowsToCostRows(rows: FocusRow[], range: CostFetchRange): CostRow[] {
  const rangeStart = dayStart(range.fromDate);
  const rangeEnd = dayStart(range.toDate) + DAY_MS;
  const agg = new Map<string, CostRow>();
  for (const row of rows) {
    const amount = num(row.BilledCost);
    if (amount === 0) continue;
    const startMs = Date.parse(row.ChargePeriodStart ?? "");
    let endMs = Date.parse(row.ChargePeriodEnd ?? "");
    if (!Number.isFinite(startMs)) continue;
    if (!Number.isFinite(endMs) || endMs <= startMs) endMs = startMs + DAY_MS;
    const span = endMs - startMs;
    const userTags = parseTags(row.Tags);
    const tags: Record<string, string> = { ...userTags };
    if (row.ResourceType) tags["resourceType"] = String(row.ResourceType);
    if (row.ResourceName) tags["resourceName"] = String(row.ResourceName);
    const consumed = num(row.ConsumedQuantity);
    const ct = chargeType(row.ChargeCategory);
    for (let day = Math.floor(startMs / DAY_MS) * DAY_MS; day < endMs; day += DAY_MS) {
      if (day < rangeStart || day >= rangeEnd) continue;
      const overlap = Math.min(endMs, day + DAY_MS) - Math.max(startMs, day);
      if (overlap <= 0) continue;
      const share = overlap / span;
      const date = ymd(day);
      const service = serviceOf(row);
      const region = row.RegionId ?? row.RegionName ?? "";
      const resourceId = row.ResourceId !== undefined ? String(row.ResourceId) : "";
      const key = [date, service, region, resourceId, ct, JSON.stringify(tags)].join("|");
      const existing = agg.get(key);
      if (existing) {
        existing.amount += amount * share;
        if (consumed) existing.usageAmount = (existing.usageAmount ?? 0) + consumed * share;
      } else {
        agg.set(key, {
          date,
          service,
          ...(region ? { region } : {}),
          ...(resourceId ? { resourceId } : {}),
          ...(Object.keys(tags).length ? { tags } : {}),
          currency: row.BillingCurrency || "USD",
          amount: amount * share,
          ...(consumed && row.ConsumedUnit
            ? { usageAmount: consumed * share, usageUnit: row.ConsumedUnit }
            : {}),
          ...(ct !== "usage" ? { chargeType: ct } : {}),
        });
      }
    }
  }
  return [...agg.values()].map((r) => ({ ...r, amount: Math.round(r.amount * 1e6) / 1e6 }));
}

function reportIdOf(task: RcTask): string | undefined {
  const resource = task.response?.resource as { costReportId?: string } | undefined;
  return resource?.costReportId;
}

/** Generate one report window and download it as FOCUS JSON rows. */
export async function fetchCostReport(
  ctx: RedisCloudContext,
  window: CostFetchRange,
  timeoutMs = 90_000,
): Promise<FocusRow[]> {
  const started = await rcFetch<RcTask>(ctx, "POST", "/cost-report", {
    startDate: window.fromDate,
    endDate: window.toDate,
    format: "json",
  });
  const task = await waitForTask(ctx, started, timeoutMs, 2_000);
  if (task.status === "processing-error") throw new TaskFailedError(taskErrorText(task), task);
  const id = reportIdOf(task);
  if (!id) {
    throw new Error(
      `Redis Cloud cost report for ${window.fromDate}..${window.toDate} did not finish in time`,
    );
  }
  const body = await rcFetch<unknown>(ctx, "GET", `/cost-report/${encodeURIComponent(id)}`);
  if (Array.isArray(body)) return body as FocusRow[];
  const wrapped = body as { rows?: FocusRow[]; data?: FocusRow[] } | undefined;
  return wrapped?.rows ?? wrapped?.data ?? [];
}

/** True for the refusals that mean "this key may not generate reports". */
function isReportPermissionFailure(err: unknown): boolean {
  const status = statusOf(err);
  if (status === 401 || status === 403) return true;
  if (err instanceof TaskFailedError) return /UNAUTHORIZED|permission|role/i.test(err.message);
  return false;
}

export interface InventorySource {
  proSubscriptions(): Promise<RcProSubscription[]>;
  essentialsSubscriptions(): Promise<RcEssentialsSubscription[]>;
  proPricing(subscriptionId: number): Promise<RcPricing[]>;
}

function daysInMonth(date: string): number {
  const d = new Date(`${date}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

/**
 * List-price estimate for one day from current inventory. Only meaningful
 * for today: inventory says nothing about what existed on earlier days.
 */
export async function estimateDay(src: InventorySource, date: string): Promise<CostRow[]> {
  const rows: CostRow[] = [];
  const tags = { costBasis: "list-price-estimate" };
  for (const sub of await src.proSubscriptions()) {
    if (sub.id === undefined || String(sub.status ?? "").toLowerCase() === "deleting") continue;
    let pricing = sub.subscriptionPricing ?? [];
    if (pricing.length === 0) pricing = await src.proPricing(sub.id).catch(() => []);
    let amount = 0;
    let currency = "USD";
    let region: string | undefined;
    for (const line of pricing) {
      const unit = num(line.pricePerUnit);
      const qty = line.quantity === undefined ? 1 : num(line.quantity);
      const period = String(line.pricePeriod ?? "").toLowerCase();
      amount += period.startsWith("hour") ? unit * qty * 24 : (unit * qty) / daysInMonth(date);
      if (line.priceCurrency) currency = line.priceCurrency;
      region ??= line.region;
    }
    if (amount <= 0) continue;
    region ??= sub.cloudDetails?.[0]?.regions?.[0]?.region;
    rows.push({
      date,
      service: "Redis Cloud Pro",
      ...(region ? { region } : {}),
      resourceId: String(sub.id),
      tags: { ...tags, resourceType: "Subscription", resourceName: sub.name ?? String(sub.id) },
      currency,
      amount: Math.round(amount * 1e6) / 1e6,
    });
  }
  for (const sub of await src.essentialsSubscriptions()) {
    if (sub.id === undefined || !sub.price) continue;
    const monthly = String(sub.pricePeriod ?? "month")
      .toLowerCase()
      .startsWith("hour")
      ? sub.price * HOURS_PER_MONTH
      : sub.price;
    rows.push({
      date,
      service: "Redis Cloud Essentials",
      ...(sub.region ? { region: sub.region } : {}),
      resourceId: String(sub.id),
      tags: { ...tags, resourceType: "Subscription", resourceName: sub.name ?? String(sub.id) },
      currency: sub.priceCurrency || "USD",
      amount: Math.round((monthly / daysInMonth(date)) * 1e6) / 1e6,
    });
  }
  return rows;
}

export async function fetchRedisCloudCostData(
  ctx: RedisCloudContext,
  src: InventorySource,
  range: CostFetchRange,
  now: Date = new Date(),
): Promise<CostRow[] | CostFetchResult> {
  const rows: CostRow[] = [];
  try {
    for (const window of splitRange(range)) {
      rows.push(...focusRowsToCostRows(await fetchCostReport(ctx, window), window));
    }
    return rows;
  } catch (err) {
    if (!isReportPermissionFailure(err)) throw err;
    const today = ymd(now.getTime());
    if (today < range.fromDate || today > range.toDate) {
      throw new CostSetupError(
        "This Redis Cloud user key cannot generate cost reports. Use a key that belongs to a user with the Owner, Viewer or Billing admin role to collect billed cost.",
        { label: "Manage API keys", url: "https://cloud.redis.io/#/access-management/api-keys" },
      );
    }
    return { rows: await estimateDay(src, today), degraded: true };
  }
}
