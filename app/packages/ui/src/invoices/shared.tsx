import { MANAGED_INVOICE_STATUS_LABELS, type ManagedInvoiceStatus } from "@infrawrench/client-core";

/* ------------------------------------------------------------------ *
 * Small shared bits
 * ------------------------------------------------------------------ */

const STATUS_CLASS: Record<ManagedInvoiceStatus, string> = {
  draft: "text-on-surface-faint",
  approved: "text-info",
  sent: "text-success",
  void: "text-danger",
};

export function StatusChip({ status }: { status: ManagedInvoiceStatus }) {
  return (
    <span className={`text-xs uppercase tracking-wide ${STATUS_CLASS[status]}`}>
      {MANAGED_INVOICE_STATUS_LABELS[status]}
    </span>
  );
}

export function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/**
 * Add or remove `id`, keeping the list itself as the source of truth: click
 * order is what gets sent and stored, so membership is tested against a set
 * built from the list rather than the list being rebuilt from a set.
 */
export function toggle(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

/** The last complete calendar month — the period an invoice almost always covers. */
export function lastMonth(): { from: string; to: string } {
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

export const BTN =
  "rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface hover:border-border-strong disabled:opacity-50";
export const FIELD =
  "rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm text-on-surface focus:outline-none focus:border-blue-500";
