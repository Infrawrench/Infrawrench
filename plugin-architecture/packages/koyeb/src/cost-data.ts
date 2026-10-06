import type { CostFetchRange, CostRow } from "@infrawrench/plugin-base";
import type { KyNextInvoice } from "./types.js";

/**
 * Billed spend from `GET /v1/billing/next_invoice` (marked experimental in
 * the spec; it is what the Koyeb control panel's Usage page renders). It is
 * the open invoice for the current billing period: one Stripe line per
 * metered product (`plan_nickname`, e.g. "Small instance", "Database
 * storage") with `quantity` and `amount_excluding_tax` in cents, plus the
 * plan fee line. Rows are dated to each line's period start and rewritten on
 * every pass while the month is open (`periodNative`); discounts become one
 * credit row from the Stripe subtotal/total difference. Closed months keep
 * the rows written while they were open: Koyeb exposes no past invoices over
 * the API. Hobby organizations have no invoice and answer an error, which
 * is read as "nothing billed".
 */

const PLANS = new Set(["Starter", "Startup", "Pro", "Scale", "Business", "Enterprise"]);

function day(iso: string | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "" : new Date(t).toISOString().slice(0, 10);
}

export function invoiceRows(inv: KyNextInvoice, range: CostFetchRange): CostRow[] {
  const out: CostRow[] = [];
  let firstDay = "";
  for (const line of inv.lines ?? []) {
    const date = day(line.period?.start);
    if (!date) continue;
    if (!firstDay || date < firstDay) firstDay = date;
    const cents = Number(line.amount_excluding_tax ?? 0);
    if (!Number.isFinite(cents) || cents === 0) continue;
    const name = line.plan_nickname || "Koyeb";
    const plan = PLANS.has(name);
    out.push({
      date,
      service: plan ? `${name} plan` : name,
      currency: "USD",
      amount: cents / 100,
      ...(!plan && typeof line.quantity === "number" ? { usageAmount: line.quantity } : {}),
      chargeType: plan ? "other" : "usage",
    });
  }
  const sub = Number(inv.stripe_invoice?.subtotal_excluding_tax);
  const total = Number(inv.stripe_invoice?.total_excluding_tax);
  if (firstDay && Number.isFinite(sub) && Number.isFinite(total) && total !== sub) {
    out.push({
      date: firstDay,
      service: "Discounts",
      currency: "USD",
      amount: (total - sub) / 100,
      chargeType: "credit",
    });
  }
  // Keep only months the host asked about (dated to the period start).
  const from = `${range.fromDate.slice(0, 7)}-01`;
  return out.filter((r) => r.date >= from && r.date <= range.toDate);
}
