import type { CostRow, CreditBalance } from "@infrawrench/plugin-base";
import type { Billing } from "./types.js";

/**
 * Spend from `GET /billing` (the only billing read the API offers, 2026-10).
 * It carries the running month split by product (`MonthlyChargesStorage`,
 * `MonthlyChargesEUTraffic`, …, `MonthlyChargesTaxes`) and `BillingRecords`,
 * where `Type` 3 (`MonthlyUsage`) is each closed month's total deduction from
 * the prepaid balance. So the current month is broken down by product (and,
 * for CDN traffic, by billing region) while past months are one total each.
 * Everything is dated to the 1st of its month (period-native).
 */

const TRAFFIC_REGIONS: Record<string, string> = {
  EUTraffic: "EU",
  USTraffic: "US",
  ASIATraffic: "ASIA",
  AFTraffic: "AF",
  SATraffic: "SA",
};

const LABELS: Record<string, string> = {
  Storage: "Edge Storage",
  DNS: "DNS",
  Optimizer: "Optimizer",
  Transcribe: "Stream transcribing",
  PremiumEncoding: "Stream premium encoding",
  ExtraPullZones: "Extra pull zones",
  ExtraStorageZones: "Extra storage zones",
  ExtraDnsZones: "Extra DNS zones",
  ExtraVideoLibraries: "Extra video libraries",
  Scripting: "Edge Scripting",
  ScriptingRequests: "Edge Scripting requests",
  ScriptingCpu: "Edge Scripting CPU",
  Drm: "Stream DRM",
  MagicContainers: "Magic Containers",
  Shield: "Bunny Shield",
  WebSockets: "WebSockets",
  DB: "Bunny Database",
  LoadBalancer: "Load balancer",
  AiGateway: "AI Gateway",
  Taxes: "Taxes",
};

export function monthStart(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

function humanize(key: string): string {
  return LABELS[key] ?? key.replace(/([a-z])([A-Z])/g, "$1 $2");
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export function billingCostRows(billing: Billing, now = new Date()): CostRow[] {
  const current = monthStart(now);
  const rows: CostRow[] = [];
  for (const [key, raw] of Object.entries(billing)) {
    if (!key.startsWith("MonthlyCharges") || typeof raw !== "number" || raw === 0) continue;
    const part = key.slice("MonthlyCharges".length);
    const region = TRAFFIC_REGIONS[part];
    rows.push({
      date: current,
      currency: "USD",
      amount: round(raw),
      service: region ? "CDN traffic" : humanize(part),
      ...(region ? { region } : {}),
      ...(part === "Taxes" ? { chargeType: "tax" as const } : {}),
    });
  }
  const seen = new Set<string>();
  for (const rec of billing.BillingRecords ?? []) {
    if (rec.Type !== 3) continue;
    const ts = Date.parse(rec.Timestamp);
    if (!Number.isFinite(ts)) continue;
    // The record lands at (or just after) the end of the month it covers.
    const month = monthStart(new Date(ts - 86_400_000));
    if (month >= current) continue;
    const amount = Math.abs(rec.Amount);
    if (seen.has(month)) {
      const row = rows.find((r) => r.date === month);
      if (row) row.amount = round(row.amount + amount);
      continue;
    }
    seen.add(month);
    rows.push({ date: month, currency: "USD", amount: round(amount), service: "All products" });
  }
  return rows;
}

export function creditBalances(billing: Billing): CreditBalance[] {
  const out: CreditBalance[] = [];
  if (typeof billing.Balance === "number") {
    out.push({
      key: "balance",
      label: "Prepaid balance",
      remaining: round(billing.Balance),
      currency: "USD",
    });
  }
  if (typeof billing.CouponBalance === "number" && billing.CouponBalance > 0) {
    out.push({
      key: "coupon",
      label: "Coupon balance",
      remaining: round(billing.CouponBalance),
      currency: "USD",
    });
  }
  return out;
}

/** This month's charges by product, for the account detail. */
export function chargesBreakdown(billing: Billing): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of billingCostRows(billing)) {
    if (r.service === "All products") continue;
    const key = r.region ? `${r.service} (${r.region})` : (r.service ?? "Other");
    out[key] = round((out[key] ?? 0) + r.amount);
  }
  return out;
}
