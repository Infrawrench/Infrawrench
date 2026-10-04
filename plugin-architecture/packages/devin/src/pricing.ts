/**
 * Turning ACUs into money.
 *
 * Devin's API meters consumption in Agent Compute Units but never prices it:
 * Enterprise contracts set the ACU rate in the order form, and no endpoint
 * exposes it, nor an invoice. So every amount this plugin writes is ACUs times
 * a price per ACU, and that price is a credential field the user overwrites
 * with their own rate (Edit credentials) at any time. The manifest declares
 * `estimated`.
 *
 * The default is Devin's published pay-as-you-go rate of $2.25 per ACU
 * (Devin 2.0 Core plan, April 2025; the legacy Team plan billed extra ACUs at
 * $2.00). Self-serve plans have since moved to on-demand credits, which Devin
 * documents as "the same dollar value as the ACUs you're used to"
 * (https://docs.devin.ai/admin/billing/self-serve, checked 2026-10).
 */

export const DEFAULT_ACU_PRICE = "2.25";
export const ACU_PRICE_KEY = "acuPrice";

export function parseAcuPrice(credentials: Record<string, string>): number {
  const raw = (credentials[ACU_PRICE_KEY] ?? "").trim().replace(/^\$/, "").replace(/,/g, "");
  const value = raw === "" ? DEFAULT_ACU_PRICE : raw;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Devin plugin: "Price per ACU" must be a non-negative number, got "${raw}".`);
  }
  return n;
}

/**
 * Products Devin splits a day's ACUs into (`acus_by_product`), as the cost
 * `service`. Stable: they key stored rows. Devin documents `devin` as sessions
 * a person or service user started (code-scan and on-call sessions included)
 * and `automation` as everything automations spend; `cascade`, `terminal` and
 * `review` are named after Devin's own buckets rather than guessed at.
 */
export const PRODUCT_LABELS = {
  devin: "Devin sessions",
  automation: "Automations",
  cascade: "Cascade",
  terminal: "Terminal",
  review: "Devin Review",
} as const;

export type ProductKey = keyof typeof PRODUCT_LABELS;
export const PRODUCT_KEYS = Object.keys(PRODUCT_LABELS) as ProductKey[];

/** ACUs per product for one day. Devin returns null for buckets it cannot break out. */
export type AcusByProduct = Partial<Record<ProductKey, number | null>>;

export const roundMoney = (n: number): number => Math.round(n * 1e6) / 1e6;
