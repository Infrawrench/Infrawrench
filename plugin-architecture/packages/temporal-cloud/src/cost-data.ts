/**
 * Temporal Cloud spend.
 *
 * Primary source: the Cloud Billing API (`POST /cloud/billing-reports`, then
 * `GET /cloud/billing-reports/{id}` until `BILLING_REPORT_STATE_GENERATED`,
 * then the CSV behind `downloadInfo[].url`). Reports are FOCUS-shaped, one
 * row per charge, with namespace-level attribution and the namespace's tags
 * (https://docs.temporal.io/cloud/billing-api). They must be requested on
 * billing-month boundaries, and each granularity has its own reach: daily for
 * the current and previous two months, monthly for the current and previous
 * eleven. Only one report per account generates at a time; the rest queue.
 *
 * So one collection pass asks for at most two reports, cached on the client
 * across the host's month chunks: a daily report covering the daily window,
 * and (on a backfill only) one monthly report for the older months, whose
 * rows are dated to the first of the month.
 *
 * Fallback: when the key may not create billing reports (it needs the Owner
 * or Finance Admin role) or a daily report fails or does not finish in time,
 * the last 90 days are estimated from `GET /cloud/usage` (actions, active
 * storage and retained storage per namespace per day) at the account's
 * editable rates (`pricing.ts`). Those rows carry `cost_source=estimated`,
 * billed rows `cost_source=billed`, so the two are never confused, and the
 * next pass that gets a report replaces the estimates (the host reconciles
 * rows a collection no longer writes).
 */

import type { CostChargeType, CostFetchRange, CostRow } from "@infrawrench/plugin-base";
import type { TemporalContext } from "./api.js";
import { fetchText, isPermissionError, statusOf, tcFetch } from "./api.js";
import type { TemporalRates } from "./pricing.js";
import { actionsCost, byteSecondsToGbh, planCost } from "./pricing.js";

export const COST_SOURCE_TAG = "cost_source";

/** Namespace id → what cost rows need to know about it. */
export type NamespaceIndex = Map<string, { region?: string; tags?: Record<string, string> }>;

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

export function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

export function addMonths(monthStartDay: string, n: number): string {
  const [y, m] = monthStartDay.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 10);
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysInMonth(day: string): number {
  const [y, m] = day.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** RFC 4180 parser: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((v) => v !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v !== "")) rows.push(row);
  return rows;
}

export function csvRecords(text: string): Array<Record<string, string>> {
  const [header, ...body] = parseCsv(text.replace(/^﻿/, ""));
  if (!header) return [];
  const keys = header.map((h) => h.trim());
  return body.map((cells) => {
    const rec: Record<string, string> = {};
    keys.forEach((k, i) => {
      rec[k] = (cells[i] ?? "").trim();
    });
    return rec;
  });
}

// ---------------------------------------------------------------------------
// Billing report rows
// ---------------------------------------------------------------------------

function chargeTypeOf(category: string, service: string): CostChargeType {
  switch (category.toLowerCase()) {
    case "usage":
      return /plan|support/i.test(service) ? "support" : "usage";
    case "purchase":
      return /plan|support/i.test(service) ? "support" : "commitment_fee";
    case "credit":
      return "credit";
    case "tax":
      return "tax";
    case "adjustment":
      return "adjustment";
    case "refund":
      return "refund";
    case "":
      return "usage";
    default:
      return "other";
  }
}

/** `{"$tmprl_project":["p1"],"team":["core"]}` → `{ temporal_project: "p1", team: "core" }`. */
export function parseTags(raw: string): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed ?? {})) {
      const first = Array.isArray(value) ? value[0] : value;
      if (first === undefined || first === null || first === "") continue;
      out[key === "$tmprl_project" ? "temporal_project" : key.replace(/^\$/, "")] = String(first);
    }
    return out;
  } catch {
    return {};
  }
}

const num = (v: string | undefined): number => {
  const n = Number((v ?? "").replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

/**
 * Whether amounts are in minor units. The documented example for
 * `BillingCurrency` reads "USD (cents)", which leaves open whether the cost
 * columns are dollars or cents. Two signals settle it: the currency cell
 * mentioning cents, or an actions unit price that can only be cents (the
 * published price per million actions is $25 to $50, so anything above 100
 * per million is a price in cents).
 */
export function amountsInCents(records: Array<Record<string, string>>): boolean {
  for (const r of records) {
    if (/cent/i.test(r["BillingCurrency"] ?? "")) return true;
    const unit = r["PricingUnit"] ?? "";
    if (/million/i.test(unit) && /action/i.test(`${unit} ${r["SKUMeter"] ?? ""}`)) {
      if (num(r["ContractedUnitPrice"]) > 100) return true;
    }
  }
  return false;
}

export function billingReportRows(
  csv: string,
  namespaces: NamespaceIndex,
  monthly: boolean,
): CostRow[] {
  const records = csvRecords(csv);
  const divisor = amountsInCents(records) ? 100 : 1;
  const merged = new Map<string, CostRow>();
  for (const r of records) {
    const start = r["ChargePeriodStart"] || r["BillingPeriodStart"] || "";
    if (!/^\d{4}-\d{2}-\d{2}/.test(start)) continue;
    const date = monthly ? monthStart(start.slice(0, 10)) : start.slice(0, 10);
    const service =
      r["ServiceSubcategory"] || r["SKUMeter"] || r["ChargeDescription"] || "Temporal Cloud";
    const chargeType = chargeTypeOf(r["ChargeCategory"] ?? "", `${service} ${r["SKUId"] ?? ""}`);
    // `ResourceID` is the namespace id (`<name>.<account>`) on namespace
    // charges and empty on account-level ones (plan, support, credits).
    const resourceId = r["ResourceID"] || undefined;
    const ns = resourceId ? namespaces.get(resourceId) : undefined;
    const tags = { ...parseTags(r["Tags"] ?? ""), [COST_SOURCE_TAG]: "billed" };
    const currency = /([A-Z]{3})/.exec(r["BillingCurrency"] ?? "")?.[1] ?? "USD";
    const amount = num(r["ContractedCost"]) / divisor;
    const quantity = num(r["PricingQuantity"]);
    const unit = r["PricingUnit"] || undefined;
    const tagKey = Object.entries(tags)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    const key = [date, service, resourceId ?? "", chargeType, currency, unit ?? "", tagKey].join(
      "|",
    );
    const existing = merged.get(key);
    if (existing) {
      existing.amount += amount;
      if (existing.usageAmount !== undefined) existing.usageAmount += quantity;
      continue;
    }
    merged.set(key, {
      date,
      service,
      ...(resourceId ? { resourceId } : {}),
      ...(ns?.region ? { region: ns.region } : {}),
      tags,
      currency,
      amount,
      ...(unit ? { usageAmount: quantity, usageUnit: unit } : {}),
      ...(chargeType !== "usage" ? { chargeType } : {}),
    });
  }
  return [...merged.values()];
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

interface BillingReport {
  id?: string;
  state?: string;
  downloadInfo?: Array<{ url?: string; fileFormat?: string }>;
}

export class BillingReportUnavailable extends Error {
  constructor(
    message: string,
    readonly permission: boolean,
  ) {
    super(message);
    this.name = "BillingReportUnavailable";
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface ReportTiming {
  timeoutMs: number;
  initialPollMs: number;
  maxPollMs: number;
}

export const DEFAULT_REPORT_TIMING: ReportTiming = {
  timeoutMs: 10 * 60_000,
  initialPollMs: 3_000,
  maxPollMs: 30_000,
};

/**
 * Create a billing report for `[startMonth, endMonth)`, wait for it, and
 * return its CSV text.
 */
export async function generateBillingReport(
  ctx: TemporalContext,
  startMonth: string,
  endMonth: string,
  granularity: "DAILY" | "MONTHLY",
  timing: ReportTiming = DEFAULT_REPORT_TIMING,
): Promise<string> {
  let created: { billingReportId?: string };
  try {
    created = await tcFetch<{ billingReportId?: string }>(ctx, "/cloud/billing-reports", {
      method: "POST",
      body: {
        spec: {
          startTimeInclusive: `${startMonth}T00:00:00Z`,
          endTimeExclusive: `${endMonth}T00:00:00Z`,
          granularity: `BILLING_REPORT_GRANULARITY_${granularity}`,
          downloadUrlExpirationDuration: "3600s",
          description: "Infrawrench cost collection",
        },
      },
    });
  } catch (err) {
    if (isPermissionError(err)) {
      throw new BillingReportUnavailable(
        "This API key cannot create billing reports. Billing reports need a key owned by a user or service account with the Owner or Finance Admin role.",
        true,
      );
    }
    throw err;
  }
  const id = created.billingReportId;
  if (!id)
    throw new BillingReportUnavailable("Temporal Cloud returned no billing report id", false);

  const deadline = Date.now() + timing.timeoutMs;
  let wait = timing.initialPollMs;
  for (;;) {
    const res = await tcFetch<{ billingReport?: BillingReport }>(
      ctx,
      `/cloud/billing-reports/${encodeURIComponent(id)}`,
    );
    const report = res.billingReport;
    if (report?.state === "BILLING_REPORT_STATE_GENERATED") {
      const urls = (report.downloadInfo ?? []).map((d) => d.url ?? "").filter(Boolean);
      if (urls.length === 0) {
        throw new BillingReportUnavailable("The billing report has no download link", false);
      }
      const parts: string[] = [];
      for (const url of urls) {
        const file = await fetchText(ctx, url);
        if (file.status < 200 || file.status >= 300) {
          throw new BillingReportUnavailable(
            `Downloading the billing report failed with HTTP ${file.status}`,
            false,
          );
        }
        parts.push(file.body);
      }
      // Several files share one header; keep the first copy only.
      return parts.map((p, i) => (i === 0 ? p : p.split(/\r?\n/).slice(1).join("\n"))).join("\n");
    }
    if (report?.state === "BILLING_REPORT_STATE_FAILED") {
      throw new BillingReportUnavailable(
        "Temporal Cloud failed to generate the billing report",
        false,
      );
    }
    if (Date.now() + wait > deadline) {
      throw new BillingReportUnavailable(
        "The billing report is still generating; it will be collected on the next pass",
        false,
      );
    }
    await sleep(wait);
    wait = Math.min(wait * 2, timing.maxPollMs);
  }
}

// ---------------------------------------------------------------------------
// Usage fallback
// ---------------------------------------------------------------------------

interface UsageSummary {
  startTime?: string;
  incomplete?: boolean;
  recordGroups?: Array<{
    groupBys?: Array<{ key?: string; value?: string }>;
    records?: Array<{ type?: string; unit?: string; value?: number }>;
  }>;
}

export async function fetchUsageSummaries(
  ctx: TemporalContext,
  startDay: string,
  endDayExclusive: string,
): Promise<UsageSummary[]> {
  const out: UsageSummary[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 100; page++) {
    const res = await tcFetch<{ summaries?: UsageSummary[]; nextPageToken?: string }>(
      ctx,
      "/cloud/usage",
      {
        query: {
          startTimeInclusive: `${startDay}T00:00:00Z`,
          endTimeExclusive: `${endDayExclusive}T00:00:00Z`,
          pageSize: 1000,
          ...(pageToken ? { pageToken } : {}),
        },
      },
    );
    out.push(...(res.summaries ?? []));
    if (!res.nextPageToken) break;
    pageToken = res.nextPageToken;
  }
  return out;
}

/** Usage × rates for the days in `range` that are inside the 90-day usage window. */
export async function estimateFromUsage(
  ctx: TemporalContext,
  range: CostFetchRange,
  rates: TemporalRates,
  namespaces: NamespaceIndex,
  today: string = isoDay(new Date()),
): Promise<CostRow[]> {
  // The usage endpoint only answers for the last 90 days (midnight-aligned).
  const earliest = addDays(today, -89);
  // Start at the month boundary so volume tiers see the month-to-date count.
  const start = [monthStart(range.fromDate), earliest].sort().at(-1) ?? earliest;
  const endExclusive = [addDays(range.toDate, 1), addDays(today, 1)].sort()[0] ?? today;
  if (start >= endExclusive) return [];
  const summaries = await fetchUsageSummaries(ctx, start, endExclusive);

  interface Day {
    date: string;
    ns: Map<string, { actions: number; active: number; retained: number }>;
  }
  const days = new Map<string, Day>();
  for (const s of summaries) {
    const date = (s.startTime ?? "").slice(0, 10);
    if (!date) continue;
    const day = days.get(date) ?? { date, ns: new Map() };
    days.set(date, day);
    for (const g of s.recordGroups ?? []) {
      const nsId =
        g.groupBys?.find((b) => b.key === "GROUP_BY_KEY_NAMESPACE")?.value ??
        g.groupBys?.[0]?.value ??
        "";
      const entry = day.ns.get(nsId) ?? { actions: 0, active: 0, retained: 0 };
      for (const rec of g.records ?? []) {
        const v = typeof rec.value === "number" ? rec.value : Number(rec.value ?? 0);
        if (!Number.isFinite(v)) continue;
        if (rec.type === "RECORD_TYPE_ACTIONS") entry.actions += v;
        else if (rec.type === "RECORD_TYPE_ACTIVE_STORAGE") entry.active += v;
        else if (rec.type === "RECORD_TYPE_RETAINED_STORAGE") entry.retained += v;
      }
      day.ns.set(nsId, entry);
    }
  }

  const rows: CostRow[] = [];
  const monthActions = new Map<string, number>();
  const monthUsage = new Map<string, { spend: number; days: Set<string> }>();
  for (const day of [...days.values()].sort((a, b) => a.date.localeCompare(b.date))) {
    const month = monthStart(day.date);
    const before = monthActions.get(month) ?? 0;
    const dayActions = [...day.ns.values()].reduce((sum, e) => sum + e.actions, 0);
    const after = before + dayActions;
    monthActions.set(month, after);
    const dayActionsCost = actionsCost(before, after, rates);
    const usage = monthUsage.get(month) ?? { spend: 0, days: new Set<string>() };
    usage.days.add(day.date);
    monthUsage.set(month, usage);
    for (const [nsId, e] of day.ns) {
      const meta = nsId ? namespaces.get(nsId) : undefined;
      const base = {
        date: day.date,
        ...(nsId ? { resourceId: nsId } : {}),
        ...(meta?.region ? { region: meta.region } : {}),
        tags: { ...(meta?.tags ?? {}), [COST_SOURCE_TAG]: "estimated" },
        currency: "USD",
      };
      const share = dayActions > 0 ? e.actions / dayActions : 0;
      const items: Array<[string, number, number, string]> = [
        ["Actions", dayActionsCost * share, e.actions, "Actions"],
        [
          "Active Storage",
          byteSecondsToGbh(e.active) * rates.activeStoragePerGbh,
          byteSecondsToGbh(e.active),
          "GB-Hours",
        ],
        [
          "Retained Storage",
          byteSecondsToGbh(e.retained) * rates.retainedStoragePerGbh,
          byteSecondsToGbh(e.retained),
          "GB-Hours",
        ],
      ];
      for (const [service, amount, usageAmount, usageUnit] of items) {
        if (usageAmount <= 0) continue;
        usage.spend += amount;
        rows.push({ ...base, service, amount, usageAmount, usageUnit });
      }
    }
  }
  // Plan charge, spread evenly over the days the window covers.
  for (const [month, usage] of monthUsage) {
    const total = planCost(usage.spend, usage.days.size, daysInMonth(month), rates);
    if (total <= 0) continue;
    for (const date of usage.days) {
      rows.push({
        date,
        service: "Plan",
        tags: { [COST_SOURCE_TAG]: "estimated" },
        currency: "USD",
        amount: total / usage.days.size,
        chargeType: "support",
      });
    }
  }
  return rows.filter((r) => r.date >= range.fromDate && r.date <= range.toDate);
}

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

/**
 * Per-client state for one collection pass. The host walks month chunks
 * oldest first and reuses one client for the whole pass, so reports are
 * generated once and every chunk filters the cached rows.
 */
export class TemporalCostCollector {
  private daily?: Promise<CostRow[] | BillingReportUnavailable>;
  private monthly?: { from: string; rows: Promise<CostRow[]> };

  constructor(
    private readonly ctx: TemporalContext,
    private readonly rates: TemporalRates,
    private readonly namespaces: () => Promise<NamespaceIndex>,
    private readonly timing: ReportTiming = DEFAULT_REPORT_TIMING,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async fetch(range: CostFetchRange): Promise<CostRow[]> {
    const today = isoDay(this.now());
    const currentMonth = monthStart(today);
    const dailyStart = addMonths(currentMonth, -2);
    const monthlyStart = addMonths(currentMonth, -11);
    const nextMonth = addMonths(currentMonth, 1);
    const inRange = (rows: CostRow[]) =>
      rows.filter((r) => r.date >= range.fromDate && r.date <= range.toDate);

    const chunkMonth = monthStart(range.fromDate);
    const out: CostRow[] = [];

    // The part of the chunk older than the daily window: monthly report.
    if (chunkMonth < dailyStart) {
      const from = chunkMonth < monthlyStart ? monthlyStart : chunkMonth;
      if (from < dailyStart) {
        if (!this.monthly || this.monthly.from > from) {
          this.monthly = {
            from,
            rows: (async () => {
              const csv = await generateBillingReport(
                this.ctx,
                from,
                dailyStart,
                "MONTHLY",
                this.timing,
              );
              return billingReportRows(csv, await this.namespaces(), true);
            })(),
          };
        }
        try {
          out.push(...inRange(await this.monthly.rows));
        } catch (err) {
          // Older months have no estimate to fall back to (usage reaches back
          // 90 days). A key without billing access simply has no history
          // there; anything else fails the pass so the host retries it.
          if (!(err instanceof BillingReportUnavailable && err.permission)) throw err;
        }
      }
    }

    // The daily window.
    if (range.toDate >= dailyStart) {
      this.daily ??= (async () => {
        try {
          const csv = await generateBillingReport(
            this.ctx,
            dailyStart,
            nextMonth,
            "DAILY",
            this.timing,
          );
          return billingReportRows(csv, await this.namespaces(), false);
        } catch (err) {
          if (err instanceof BillingReportUnavailable) return err;
          if (statusOf(err) >= 500) {
            return new BillingReportUnavailable(String(err), false);
          }
          throw err;
        }
      })();
      const daily = await this.daily;
      if (daily instanceof BillingReportUnavailable) {
        const sub = {
          fromDate: range.fromDate < dailyStart ? dailyStart : range.fromDate,
          toDate: range.toDate,
        };
        try {
          out.push(
            ...(await estimateFromUsage(this.ctx, sub, this.rates, await this.namespaces(), today)),
          );
        } catch (err) {
          // Neither source answered: say why in the account's cost status.
          if (isPermissionError(err) && daily.permission) throw daily;
          throw err;
        }
      } else {
        out.push(...inRange(daily));
      }
    }
    return out;
  }
}
