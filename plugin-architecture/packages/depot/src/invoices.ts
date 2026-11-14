/**
 * Billed Depot spend, from finalized invoices (`BillingService`, Depot's Node SDK
 * v2.3.2, `src/gen/depot/core/v1/billing_pb.ts`).
 *
 * Depot bills through Stripe, and the service returns the finalized invoices of the
 * Stripe customer linked to the organization: drafts and the upcoming invoice are
 * left out. Every amount is a signed integer in the smallest unit of the invoice's
 * currency.
 *
 * **Which days an invoice settles.** A subscription invoice's own period is its item
 * accrual period, which for a renewal is the billing cycle that just closed. Those
 * days are *covered*: the usage-times-rates estimate is not used for them, since the
 * invoice states what they cost. Its lines, though, each carry their own service
 * period, and that is where each line's money goes: usage billed in arrears lands on
 * the closed cycle, and a fee billed in advance (the plan) lands on the cycle it pays
 * for. A positive subscription line over a span of days that no invoice covers yet,
 * the open cycle, replaces the estimate's plan fee on those days and nothing else,
 * because a line billed ahead of its period is the fee for it; the open cycle's usage
 * is still estimated. A standalone invoice (no
 * subscription) covers nothing: its lines are charges the estimate never had.
 *
 * Period ends are rounded to the nearest UTC midnight, both for coverage and for the
 * lines, so a cycle anchored at 13:42 maps onto the same whole days on both sides and
 * the boundary day is counted once.
 *
 * **Each invoice sums to its `total`.** A line becomes up to three rows on the days it
 * covers: its amount before tax and discounts (a `credit`, `refund` or `adjustment`
 * when negative), its tax as a `tax` row, and its discounts as a negative `credit`
 * row. Whatever the total holds beyond those (an invoice-level discount not carried
 * on the lines, rounding) is an "Invoice adjustments" row over the invoice's own
 * period. Credit notes and customer balance are not subtracted: neither changes
 * `total`, and both can arrive long after the invoice.
 */

import type { CostChargeType, CostRow } from "@infrawrench/plugin-base";
import {
  isRouteUnavailable,
  listInvoiceLineItems,
  listInvoices,
  mapLimit,
  type DepotTransport,
  type WireInt64,
  type WireInvoice,
  type WireInvoiceLineItem,
} from "./api.js";
import { SERVICE } from "./services.js";

const DAY_MS = 86_400_000;
const CONCURRENCY = 4;
/**
 * How far before the window an invoice may have been created and still bill days in
 * it: a fee paid a year in advance is the longest span a line covers.
 */
const LOOKBACK_MS = 366 * DAY_MS;

export interface FinalizedInvoice {
  invoice: WireInvoice;
  lines: WireInvoiceLineItem[];
}

export interface InvoiceCosts {
  /** Rows for the days in the window that invoice lines bill. */
  rows: CostRow[];
  /** UTC midnights a finalized subscription invoice's period covers. Never estimated. */
  coveredDays: Set<number>;
  /** UTC midnights outside `coveredDays` that a subscription line bills: no estimated plan fee. */
  feeBilledDays: Set<number>;
}

/**
 * Currencies Stripe writes in whole units, and the five it writes in thousandths
 * (https://docs.stripe.com/currencies, verified November 2026). Everything else is
 * in hundredths.
 */
const ZERO_DECIMAL = new Set([
  "bif",
  "clp",
  "djf",
  "gnf",
  "jpy",
  "kmf",
  "krw",
  "mga",
  "pyg",
  "rwf",
  "ugx",
  "vnd",
  "vuv",
  "xaf",
  "xof",
  "xpf",
]);
const THREE_DECIMAL = new Set(["bhd", "jod", "kwd", "omr", "tnd"]);

/** Smallest currency units per major unit. */
export function minorUnitsPerMajor(currency: string): number {
  const c = currency.toLowerCase();
  if (ZERO_DECIMAL.has(c)) return 1;
  if (THREE_DECIMAL.has(c)) return 1000;
  return 100;
}

/** An int64 amount, signed. proto3 JSON leaves a zero out. */
function int(value: WireInt64 | undefined): number {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : 0;
  return Number.isFinite(n) ? n : 0;
}

const nearestMidnight = (ms: number) => Math.round(ms / DAY_MS) * DAY_MS;

/** The whole UTC days `[start, end)` spans once both ends are rounded to midnight. */
export function periodDays(start: string | undefined, end: string | undefined): number[] {
  const startMs = Date.parse(start ?? "");
  const endMs = Date.parse(end ?? "");
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return [];
  const days: number[] = [];
  for (let d = nearestMidnight(startMs); d < nearestMidnight(endMs); d += DAY_MS) days.push(d);
  return days;
}

/** The days a line bills: its service period, or the day of the instant it names. */
function lineDays(line: WireInvoiceLineItem, invoice: WireInvoice): number[] {
  const days = periodDays(line.periodStart, line.periodEnd);
  if (days.length > 0) return days;
  const at = [line.periodStart, invoice.createdAt, invoice.finalizedAt]
    .map((t) => Date.parse(t ?? ""))
    .find(Number.isFinite);
  return at === undefined ? [] : [Math.floor(at / DAY_MS) * DAY_MS];
}

/** A line's description without Stripe's quantity prefix and price suffix. */
export function cleanDescription(description: string): string {
  return description
    .replace(/^\s*[\d.,]+\s*[×x]\s+/, "")
    .replace(/\s*\((?:tier\s*\d+\s*)?at\s[^)]*\)\s*$/i, "")
    .trim();
}

/**
 * The service an invoice line belongs to, named like the estimate's rows where the
 * estimate has one, so a closed cycle and the open one line up by service. A line
 * with no equivalent keeps its own description rather than being folded into one.
 */
export function invoiceLineService(description: string | undefined): string {
  const d = cleanDescription(description ?? "");
  if (/mac\s?os/i.test(d)) return SERVICE.macos;
  if (/\bdepot ci\b/i.test(d)) return SERVICE.ci;
  // Sandbox compute is one pool shared by Depot CI, sandboxes and agents: no single estimate row.
  if (!/sandbox compute/i.test(d) && /sandbox|\bagents?\b/i.test(d)) return SERVICE.sandboxes;
  if (/github actions|\bactions\b|runner/i.test(d)) return SERVICE.actions;
  if (/registry/i.test(d)) return SERVICE.registry;
  if (/cache|storage/i.test(d)) return SERVICE.cache;
  if (/docker|container|\bbuild/i.test(d)) return SERVICE.builds;
  if (/\b(plan|subscription|developer|startup|business)\b/i.test(d)) return SERVICE.plan;
  return d || SERVICE.other;
}

function negativeLineChargeType(line: WireInvoiceLineItem): CostChargeType {
  if (line.proration) return "adjustment";
  if (/refund/i.test(line.description ?? "")) return "refund";
  return "credit";
}

const round = (n: number) => Number(n.toFixed(6));

/** Turn finalized invoices into rows for the days `[fromMs, toMs]` (UTC midnights). */
export function invoiceCostRows(
  invoices: readonly FinalizedInvoice[],
  fromMs: number,
  toMs: number,
): InvoiceCosts {
  const rows = new Map<string, CostRow>();
  const coveredDays = new Set<number>();
  const subscriptionLineDays = new Set<number>();

  const spread = (
    days: readonly number[],
    row: Omit<CostRow, "date" | "amount">,
    amount: number,
  ) => {
    if (amount === 0 || days.length === 0) return;
    const share = amount / days.length;
    for (const day of days) {
      if (day < fromMs || day > toMs) continue;
      const date = new Date(day).toISOString().slice(0, 10);
      const key = JSON.stringify([date, row.service, row.chargeType ?? "", row.currency, row.tags]);
      const existing = rows.get(key);
      if (existing) existing.amount += share;
      else rows.set(key, { date, ...row, amount: share });
    }
  };

  for (const { invoice, lines } of invoices) {
    if (invoice.status === "void" || invoice.status === "draft") continue;
    const invoiceCurrency = (invoice.currency || "usd").toLowerCase();
    const tags = { invoice: invoice.number || invoice.id || "" };
    const ownDays = periodDays(invoice.periodStart, invoice.periodEnd);
    const subscription = Boolean(invoice.subscriptionId);
    if (subscription) for (const d of ownDays) coveredDays.add(d);

    let linesTotal = 0;
    for (const line of lines) {
      const currency = (line.currency || invoiceCurrency).toLowerCase();
      const perMajor = minorUnitsPerMajor(currency);
      const amount = int(line.amount);
      const base = line.amountExcludingTax !== undefined ? int(line.amountExcludingTax) : amount;
      const tax = int(line.taxAmount);
      const discount = int(line.discountAmount);
      linesTotal += base + tax - discount;

      const days = lineDays(line, invoice);
      // A charge for a span of days, on a subscription: the fee, when it lands past the cover.
      if (subscription && base > 0 && periodDays(line.periodStart, line.periodEnd).length > 0) {
        for (const d of days) subscriptionLineDays.add(d);
      }
      const service = invoiceLineService(line.description);
      const common = { service, tags, currency: currency.toUpperCase() };
      spread(
        days,
        { ...common, ...(base < 0 ? { chargeType: negativeLineChargeType(line) } : {}) },
        base / perMajor,
      );
      spread(days, { ...common, chargeType: "tax" }, tax / perMajor);
      spread(days, { ...common, chargeType: "credit" }, -discount / perMajor);
    }

    const residual = int(invoice.total) - linesTotal;
    if (residual !== 0) {
      const days = ownDays.length > 0 ? ownDays : lineDays({}, invoice);
      spread(
        days,
        {
          service: SERVICE.invoiceAdjustment,
          tags,
          currency: invoiceCurrency.toUpperCase(),
          chargeType: "adjustment",
        },
        residual / minorUnitsPerMajor(invoiceCurrency),
      );
    }
  }

  const feeBilledDays = new Set([...subscriptionLineDays].filter((d) => !coveredDays.has(d)));
  return {
    rows: [...rows.values()]
      .map((row) => ({ ...row, amount: round(row.amount) }))
      .filter((row) => row.amount !== 0),
    coveredDays,
    feeBilledDays,
  };
}

/**
 * Read the invoices that can bill a day in `[fromMs, toMs]` and turn them into rows.
 * `null` when the organization cannot read them (the service not deployed for it,
 * not implemented, or refused to the token), which leaves every day to the estimate.
 * Any other failure throws, as a failed usage read does.
 */
export async function fetchInvoiceCosts(
  transport: DepotTransport,
  fromMs: number,
  toMs: number,
): Promise<InvoiceCosts | null> {
  try {
    const invoices = (await listInvoices(transport, fromMs - LOOKBACK_MS)).filter(
      (invoice) => invoice.status !== "void" && invoice.status !== "draft",
    );
    const withLines = await mapLimit(invoices, CONCURRENCY, async (invoice) => ({
      invoice,
      lines: invoice.id ? await listInvoiceLineItems(transport, invoice.id) : [],
    }));
    return invoiceCostRows(withLines, fromMs, toMs);
  } catch (err) {
    if (isRouteUnavailable(err)) return null;
    throw err;
  }
}
