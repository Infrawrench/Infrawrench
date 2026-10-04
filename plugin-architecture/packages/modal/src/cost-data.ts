/**
 * Modal spend as daily cost rows.
 *
 * Usage comes from the workspace billing report (`WorkspaceBillingReport`,
 * the call behind `Workspace.billing.report()` and `modal billing report`):
 * one item per Modal object (an App, a Sandbox, a Volume…) per day, with the
 * cost split by the resource that generated it ("CPU", "Memory", a specific
 * GPU type…). Each split becomes one row: the resource is the `service`, the
 * object id is the `resourceId`, and the environment, object name, object
 * kind and every user tag (`tag_names=["*"]`) ride as tags.
 *
 * The report is metered cost, before credits, plan allowances, reservations
 * and the egress allowance. The monthly billing summary
 * (`WorkspaceBillingSummary`) states those as `adjustments` between
 * `metered_cost` and `billed_cost`; they are written as their own charge-typed
 * rows dated to the first of the cycle, so the cash total of a month equals
 * what Modal invoices. `restatementDays` keeps the current month's first day
 * inside every incremental window so those rows are refreshed as the month
 * runs.
 *
 * Both calls are Team and Enterprise plan features
 * (https://modal.com/docs/guide/billing). On another plan Modal refuses the
 * report, which becomes a `CostSetupError` naming the plan requirement.
 */

import type { CostChargeType, CostRow, CostFetchRange } from "@infrawrench/plugin-base";
import { CostSetupError } from "@infrawrench/plugin-base";
import type { BillingReportItem, BillingSummary } from "./api.js";
import { billingReport, billingSummary } from "./api.js";
import type { ModalContext } from "./grpc.js";
import { GrpcCode, grpcCodeOf } from "./grpc.js";

const DAY_MS = 86_400_000;
const CURRENCY = "USD";
const PLAN_HELP = { label: "Compare Modal plans", url: "https://modal.com/pricing" };

/** Object kinds by Modal's id prefix (`ap-…` is an App). */
const OBJECT_KINDS: Record<string, string> = {
  ap: "App",
  sb: "Sandbox",
  vo: "Volume",
  fu: "Function",
  nb: "Notebook",
  ta: "Container",
  im: "Image",
  sv: "Shared volume",
};

export function objectKind(objectId: string): string {
  const prefix = objectId.split("-")[0] ?? "";
  return OBJECT_KINDS[prefix] ?? "Other";
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function dayStartMs(isoDay: string): number {
  return Date.parse(`${isoDay}T00:00:00Z`);
}

/** Round to the 1e-6 the API reports in, so float noise never forks a row. */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Refusals that mean "this workspace cannot use the billing API", not "it failed". */
function isPlanRefusal(err: unknown): boolean {
  const code = grpcCodeOf(err);
  return (
    code === GrpcCode.PERMISSION_DENIED ||
    code === GrpcCode.FAILED_PRECONDITION ||
    code === GrpcCode.UNIMPLEMENTED
  );
}

function planError(err: unknown): CostSetupError {
  const detail = err instanceof Error ? err.message : String(err);
  return new CostSetupError(
    `Modal did not return a billing report for this workspace (${detail}). Modal offers its billing report API on the Team and Enterprise plans; on the Starter plan, spend is visible only in the Modal dashboard.`,
    PLAN_HELP,
  );
}

/** Report items to usage rows: one per (day, object, resource type). */
export function reportToRows(items: BillingReportItem[]): CostRow[] {
  const merged = new Map<string, CostRow>();
  const add = (row: CostRow) => {
    const tagKey = JSON.stringify(
      Object.entries(row.tags ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    );
    const key = [row.date, row.service ?? "", row.resourceId ?? "", tagKey].join("|");
    const existing = merged.get(key);
    if (existing) existing.amount = round6(existing.amount + row.amount);
    else merged.set(key, { ...row, amount: round6(row.amount) });
  };
  for (const item of items) {
    if (!item.intervalStartMs) continue;
    const date = isoDate(item.intervalStartMs);
    const tags: Record<string, string> = { ...item.tags };
    if (item.environment) tags["environment"] = item.environment;
    tags["object"] = item.description || item.objectId;
    tags["objectType"] = objectKind(item.objectId);
    const base = {
      date,
      ...(item.objectId ? { resourceId: item.objectId } : {}),
      tags,
      currency: CURRENCY,
    };
    let split = 0;
    for (const [resource, amount] of Object.entries(item.costByResource)) {
      if (amount === 0) continue;
      split += amount;
      add({ ...base, service: resource.trim() || "Other", amount });
    }
    // An item without a breakdown, or whose breakdown does not account for
    // all of its cost, keeps the remainder rather than losing it.
    const remainder = round6(item.cost - split);
    if (Math.abs(remainder) >= 0.000001) add({ ...base, service: "Other", amount: remainder });
  }
  return [...merged.values()];
}

function titleCase(key: string): string {
  return key
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function chargeTypeFor(key: string, amount: number): CostChargeType {
  const k = key.toLowerCase();
  if (k.includes("credit")) return "credit";
  if (k.includes("reservation")) return amount < 0 ? "commitment_discount" : "commitment_fee";
  return "adjustment";
}

/**
 * The adjustments of one billing cycle as rows dated to its first day.
 *
 * Modal documents the adjustments as the breakdown of the difference between
 * metered and billed cost but not their sign, so the sign is taken from that
 * identity: if they sum to `billed - metered` they are used as given, if to
 * its negation they are flipped, and if neither (keys added or removed under
 * us) a single "Adjustments" row carries the difference itself. Either way the
 * month's rows add up to the invoice.
 */
export function adjustmentRows(summary: BillingSummary, cycleDate: string): CostRow[] {
  if (summary.billed === undefined) return [];
  const diff = round6(summary.billed - summary.metered);
  const entries = Object.entries(summary.adjustments).filter(([, v]) => v !== 0);
  const total = round6(entries.reduce((s, [, v]) => s + v, 0));
  const near = (a: number, b: number) => Math.abs(a - b) <= 0.01;
  let sign = 0;
  if (entries.length > 0 && near(total, diff)) sign = 1;
  else if (entries.length > 0 && near(-total, diff)) sign = -1;
  if (sign !== 0) {
    return entries.map(([key, value]) => {
      const amount = round6(sign * value);
      return {
        date: cycleDate,
        service: titleCase(key),
        tags: { adjustment: key },
        currency: CURRENCY,
        amount,
        chargeType: chargeTypeFor(key, amount),
      };
    });
  }
  if (Math.abs(diff) < 0.01) return [];
  return [
    {
      date: cycleDate,
      service: "Adjustments",
      tags: { adjustment: "unattributed" },
      currency: CURRENCY,
      amount: diff,
      chargeType: diff < 0 ? "credit" : "adjustment",
    },
  ];
}

/** First-of-month dates inside the inclusive range, never in the future. */
export function cycleStartsIn(range: CostFetchRange, nowMs = Date.now()): string[] {
  const out: string[] = [];
  const from = dayStartMs(range.fromDate);
  const to = Math.min(dayStartMs(range.toDate), nowMs);
  const first = new Date(from);
  let y = first.getUTCFullYear();
  let m = first.getUTCMonth();
  if (first.getUTCDate() !== 1) m += 1;
  for (;;) {
    const ms = Date.UTC(y, m, 1);
    if (ms > to) break;
    out.push(isoDate(ms));
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }
  return out;
}

export async function fetchModalCostData(
  ctx: ModalContext,
  range: CostFetchRange,
): Promise<CostRow[]> {
  const startMs = dayStartMs(range.fromDate);
  const endMs = dayStartMs(range.toDate) + DAY_MS;
  let items: BillingReportItem[];
  try {
    items = await billingReport(ctx, { startMs, endMs, resolution: "d", allTags: true });
  } catch (err) {
    if (isPlanRefusal(err)) throw planError(err);
    throw err;
  }
  const rows = reportToRows(items);
  for (const cycle of cycleStartsIn(range)) {
    try {
      rows.push(...adjustmentRows(await billingSummary(ctx, dayStartMs(cycle)), cycle));
    } catch (err) {
      // The usage rows already stand on their own; a summary Modal will not
      // give (an older cycle, a plan gate) only leaves the month at metered
      // cost. A rejected token is still a failure.
      if (grpcCodeOf(err) === GrpcCode.UNAUTHENTICATED) throw err;
    }
  }
  return rows;
}
