import type { CostFetchRange, CostRow } from "@infrawrench/plugin-base";
import type { CInvoice } from "./api.js";

/**
 * Billed spend from `GET /api/v1/invoices` (verified against the 2026-09-15
 * API document). Each invoice covers a billing period (`period_start`
 * inclusive, `period_end` exclusive) and embeds `invoice_items`, one per
 * cluster, each with Metronome line items (`description`, `quantity`,
 * `quantity_unit`, `unit_cost`, `total {amount, currency}`), plus
 * organization-level `adjustments` (credits such as the Basic free tier).
 *
 * Rows are period-native: dated to `period_start`, one per (cluster, line
 * item description), with the cluster as the resource, its first region and
 * plan as dimensions. Adjustments become `credit` rows with no resource. The
 * current period's invoice is a DRAFT that keeps changing, which the
 * restatement window covers. Only USD amounts become rows: an organization on
 * a credits contract is billed in CRDB_CLOUD_CREDITS / COCKROACH_CREDITS, whose
 * conversion to money the API does not state.
 */
export function invoicesToCostRows(invoices: CInvoice[], range: CostFetchRange): CostRow[] {
  const totals = new Map<string, CostRow>();
  const add = (row: CostRow) => {
    if (!Number.isFinite(row.amount) || row.amount === 0) return;
    const key = [row.date, row.service, row.resourceId ?? "", row.chargeType ?? "usage"].join("|");
    const cur = totals.get(key);
    if (cur) cur.amount += row.amount;
    else totals.set(key, { ...row });
  };
  for (const inv of invoices) {
    const date = inv.period_start.slice(0, 10);
    if (!date || date < `${range.fromDate.slice(0, 7)}-01` || date > range.toDate) continue;
    for (const item of inv.invoice_items ?? []) {
      for (const li of item.line_items ?? []) {
        if ((li.total?.currency ?? "USD") !== "USD") continue;
        add({
          date,
          service: li.description,
          resourceId: item.cluster.id,
          ...(item.cluster.regions?.[0]?.name ? { region: item.cluster.regions[0].name } : {}),
          tags: {
            cluster: item.cluster.name,
            ...(item.cluster.plan ? { plan: item.cluster.plan } : {}),
            ...(item.cluster.cloud_provider ? { cloud: item.cluster.cloud_provider } : {}),
            invoiceStatus: inv.status ?? "",
          },
          currency: "USD",
          amount: Number(li.total?.amount ?? 0),
          usageAmount: li.quantity,
          usageUnit: li.quantity_unit,
          chargeType: "usage",
        });
      }
    }
    for (const adj of inv.adjustments ?? []) {
      if ((adj.amount?.currency ?? "USD") !== "USD") continue;
      const amount = Number(adj.amount?.amount ?? 0);
      add({
        date,
        service: adj.name,
        tags: { invoiceStatus: inv.status ?? "" },
        currency: "USD",
        amount,
        chargeType: amount < 0 ? "credit" : "adjustment",
      });
    }
  }
  return [...totals.values()].map((r) => ({ ...r, amount: Math.round(r.amount * 1e6) / 1e6 }));
}
