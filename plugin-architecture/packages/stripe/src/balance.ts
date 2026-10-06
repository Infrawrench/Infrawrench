import type { CostChargeType, CostRow } from "@infrawrench/plugin-base";
import type { StripeContext } from "./api.js";
import { fromMinor, listV1 } from "./api.js";

/**
 * Stripe's own fees, read from balance transactions
 * (`GET /v1/balance_transactions`, https://docs.stripe.com/api/balance_transactions).
 *
 * Stripe has no billing or invoice API for what *it* charges a merchant: its
 * fees are netted out of the balance instead. They arrive two ways:
 *
 * 1. `fee_details` on the transaction a fee rides on: processing fees on a
 *    `charge`/`payment`, an instant-payout fee on a `payout`, a dispute fee on
 *    an `adjustment`, the fee returned on a `refund`. Each detail has a `type`:
 *    `stripe_fee`, `payment_method_passthrough_fee` (card network / local
 *    method costs passed through on IC+ pricing), `tax` (VAT/GST on Stripe's
 *    fee), `application_fee` and `withheld_tax`. The last two go to a Connect
 *    platform or a tax authority, not to Stripe, so they are not Stripe cost.
 * 2. Standalone transactions whose whole amount *is* the fee: `stripe_fee`
 *    (Billing, Radar, Connect, Tax, Identity… with the product in the
 *    description), `stripe_fx_fee` (currency conversion) and `tax_fee`.
 *
 * Amounts are minor units in the transaction's currency; rows keep that
 * currency rather than converting, because the host owns currency.
 */

export interface StripeFeeDetail {
  amount?: number;
  currency?: string;
  description?: string | null;
  type?: string;
  application?: string | null;
}

export interface StripeBalanceTransaction {
  id?: string;
  amount?: number;
  currency?: string;
  created?: number;
  description?: string | null;
  fee?: number;
  fee_details?: StripeFeeDetail[];
  net?: number;
  reporting_category?: string;
  type?: string;
  status?: string;
}

/** Transaction types whose entire (negative) amount is a Stripe fee. */
const FEE_TRANSACTION_TYPES = new Set(["stripe_fee", "stripe_fx_fee", "tax_fee"]);

/** Transaction types that are customer money coming in, for volume metrics. */
const VOLUME_TYPES = new Set(["charge", "payment"]);

/** Reporting categories (and types) → the service the fee is filed under. */
const SERVICE_BY_CATEGORY: Record<string, string> = {
  charge: "Payments",
  payment: "Payments",
  refund: "Payments",
  payment_refund: "Payments",
  dispute: "Disputes",
  dispute_reversal: "Disputes",
  payout: "Payouts",
  payout_reversal: "Payouts",
  transfer: "Connect",
  connect_reserved_funds: "Connect",
  topup: "Top-ups",
  issuing_authorization: "Issuing",
  issuing_transaction: "Issuing",
  climate_order: "Climate",
  stripe_fx_fee: "Currency conversion",
  tax_fee: "Stripe Tax",
};

/**
 * "Billing - Usage Fee (2026-09-01 - 2026-09-30)" → "Billing",
 * "Radar for Fraud Teams: 1,204 screened" → "Radar for Fraud Teams",
 * "Connect (2026-09-01 - 2026-09-30): Active Accounts" → "Connect".
 */
export function serviceFromFeeDescription(description: string | null | undefined): string {
  const text = (description ?? "").trim();
  if (!text) return "Stripe fees";
  const head = text.split(/\s*\(|:|\s+-\s+|\s+–\s+/)[0]?.trim() ?? "";
  return head || "Stripe fees";
}

function serviceFor(tx: StripeBalanceTransaction): string {
  const type = tx.type ?? "";
  if (type === "stripe_fee") return serviceFromFeeDescription(tx.description);
  const key = SERVICE_BY_CATEGORY[type] ? type : (tx.reporting_category ?? type);
  const mapped = SERVICE_BY_CATEGORY[key];
  if (mapped) return mapped;
  return key ? key.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()) : "Stripe fees";
}

function utcDay(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

interface FeeLine {
  date: string;
  service: string;
  currency: string;
  chargeType: CostChargeType;
  feeType: string;
  transactionType: string;
  amountMinor: number;
}

/**
 * The Stripe-cost lines inside one balance transaction. Positive amounts are
 * money the merchant paid Stripe; negative ones (a refunded processing fee)
 * are money Stripe gave back.
 */
export function feeLines(tx: StripeBalanceTransaction): FeeLine[] {
  if (typeof tx.created !== "number" || !tx.currency) return [];
  const date = utcDay(tx.created);
  const currency = tx.currency.toUpperCase();
  const type = tx.type ?? "";
  const service = serviceFor(tx);

  if (FEE_TRANSACTION_TYPES.has(type)) {
    const amount = -(tx.amount ?? 0);
    if (!amount) return [];
    return [
      {
        date,
        service,
        currency,
        // A positive balance credit on a fee transaction is Stripe refunding a fee.
        chargeType: amount < 0 ? "refund" : "usage",
        feeType: type,
        transactionType: type,
        amountMinor: amount,
      },
    ];
  }

  const out: FeeLine[] = [];
  for (const detail of tx.fee_details ?? []) {
    const amount = detail.amount ?? 0;
    if (!amount) continue;
    const feeType = detail.type ?? "stripe_fee";
    if (feeType === "application_fee" || feeType === "withheld_tax") continue;
    let chargeType: CostChargeType = feeType === "tax" ? "tax" : "usage";
    // On a refund the fee detail is negative: Stripe returning its fee.
    if (amount < 0) chargeType = "refund";
    out.push({
      date,
      service,
      currency,
      chargeType,
      feeType,
      transactionType: type,
      amountMinor: amount,
    });
  }
  return out;
}

/** Sum fee lines into one row per day × service × currency × charge type × fee type. */
export function feeRows(transactions: StripeBalanceTransaction[]): CostRow[] {
  const buckets = new Map<string, FeeLine>();
  for (const tx of transactions) {
    for (const line of feeLines(tx)) {
      const key = [line.date, line.service, line.currency, line.chargeType, line.feeType].join("|");
      const existing = buckets.get(key);
      if (existing) existing.amountMinor += line.amountMinor;
      else buckets.set(key, { ...line });
    }
  }
  return [...buckets.values()]
    .filter((line) => line.amountMinor !== 0)
    .map((line) => ({
      date: line.date,
      service: line.service,
      currency: line.currency,
      amount: fromMinor(line.amountMinor, line.currency),
      ...(line.chargeType !== "usage" ? { chargeType: line.chargeType } : {}),
      tags: { feeType: line.feeType },
    }))
    .sort(
      (a, b) => a.date.localeCompare(b.date) || (a.service ?? "").localeCompare(b.service ?? ""),
    );
}

/** Balance transactions are paged per UTC day, at most this many pages each. */
export const MAX_PAGES_PER_DAY = 100;

/** Every UTC day in `[fromDate, toDate]` as `YYYY-MM-DD`. */
export function daysBetween(fromDate: string, toDate: string): string[] {
  const out: string[] = [];
  const start = Date.parse(`${fromDate}T00:00:00Z`);
  const end = Date.parse(`${toDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return out;
  for (let t = start; t <= end; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/**
 * All balance transactions created on one UTC day. Paging per day keeps a
 * busy account's request count proportional to its volume and makes a capped
 * day visible on its own rather than silently truncating a whole range.
 */
export async function transactionsForDay(
  ctx: StripeContext,
  day: string,
  maxPages = MAX_PAGES_PER_DAY,
): Promise<StripeBalanceTransaction[]> {
  const gte = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);
  return listV1<StripeBalanceTransaction>(
    ctx,
    "/v1/balance_transactions",
    { "created[gte]": gte, "created[lt]": gte + 86_400 },
    maxPages,
  );
}

/** Run `fn` over `items` with at most `limit` in flight. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Stripe-fee cost rows for `[fromDate, toDate]`, never past today. */
export async function fetchFeeCostRows(
  ctx: StripeContext,
  fromDate: string,
  toDate: string,
): Promise<CostRow[]> {
  const today = new Date().toISOString().slice(0, 10);
  const days = daysBetween(fromDate, toDate < today ? toDate : today);
  const perDay = await mapLimit(days, 4, (day) => transactionsForDay(ctx, day));
  return feeRows(perDay.flat());
}

export interface DailyVolume {
  date: string;
  currency: string;
  /** Gross charge/payment volume, minor units. */
  grossMinor: number;
  /** Stripe fees (as in {@link feeLines}), minor units. */
  feesMinor: number;
  /** Refunds, minor units, positive. */
  refundsMinor: number;
  /** Number of charges and payments. */
  payments: number;
}

/** Per-day, per-currency volume and fee totals for the Metrics tab. */
export function dailyVolume(transactions: StripeBalanceTransaction[]): DailyVolume[] {
  const buckets = new Map<string, DailyVolume>();
  const bucket = (date: string, currency: string): DailyVolume => {
    const key = `${date}|${currency}`;
    let b = buckets.get(key);
    if (!b) {
      b = { date, currency, grossMinor: 0, feesMinor: 0, refundsMinor: 0, payments: 0 };
      buckets.set(key, b);
    }
    return b;
  };
  for (const tx of transactions) {
    if (typeof tx.created !== "number" || !tx.currency) continue;
    const b = bucket(utcDay(tx.created), tx.currency.toUpperCase());
    const type = tx.type ?? "";
    if (VOLUME_TYPES.has(type)) {
      b.grossMinor += tx.amount ?? 0;
      b.payments += 1;
    }
    if (type === "refund" || type === "payment_refund") b.refundsMinor += -(tx.amount ?? 0);
    for (const line of feeLines(tx)) b.feesMinor += line.amountMinor;
  }
  return [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date));
}
