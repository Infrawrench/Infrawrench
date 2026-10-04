/**
 * Grafana Cloud cost collection.
 *
 * Source: `GET /api/orgs/{org}/billed-usage?month=&year=` (scope `orgs:read`
 * or `org-billing-info:read`), Grafana's own billed figures. One item per
 * billing dimension (Metrics, Logs, Traces, Profiles, k6, IRM, Frontend
 * Observability, ...) with the org's `amountDue` for the month, the usage,
 * the included allowance and the overage, and a `usages[]` breakdown per
 * stack. These are amounts Grafana bills, at the org's own rates, so the
 * manifest does not declare `estimated`.
 *
 * The figures are monthly, so rows are period-native: each month's total is
 * dated to its 1st (see `server-core/src/cost/period-scope.ts` for why the
 * 1st matters), and a month is only written when its 1st lies inside the
 * requested range. The current month's figures are month to date and are
 * restated on every pass.
 *
 * Splitting a dimension's amount across stacks: `attributedCost` per stack
 * when Grafana provides it, otherwise proportional to each stack's
 * `totalUsage`. Either way the split is rounded to cents and the remainder
 * lands on the largest share, so a month's rows always sum to exactly what
 * Grafana says is due.
 */

import type { CostFetchRange, CostRow } from "@infrawrench/plugin-base";
import { CostSetupError } from "@infrawrench/plugin-base";
import { listStacks, orgSlugOf } from "./account.js";
import type { GrafanaContext } from "./api.js";
import { cloudFetch, statusOf } from "./api.js";
import type { GcBilledUsage, GcStack } from "./types.js";

const CURRENCY = "USD";

const SCOPE_HELP = {
  label: "Grafana Cloud access policies",
  url: "https://grafana.com/docs/grafana-cloud/security-and-account-management/authentication-and-permissions/access-policies/",
};

/** `YYYY-MM-01` for every calendar month whose 1st lies in [from, to], not after `today`. */
export function monthStartsInRange(fromDate: string, toDate: string, today: string): string[] {
  const end = toDate < today ? toDate : today;
  const out: string[] = [];
  let year = Number(fromDate.slice(0, 4));
  let month = Number(fromDate.slice(5, 7));
  if (fromDate.slice(8, 10) !== "01") {
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  for (;;) {
    const day = `${year}-${String(month).padStart(2, "0")}-01`;
    if (day > end) break;
    out.push(day);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return out;
}

/** One month of billed usage. A month before the org existed answers empty. */
export async function fetchBilledUsage(
  ctx: GrafanaContext,
  orgSlug: string,
  monthStart: string,
): Promise<GcBilledUsage[]> {
  try {
    const res = await cloudFetch<{ items?: GcBilledUsage[] }>(
      ctx,
      `/orgs/${encodeURIComponent(orgSlug)}/billed-usage`,
      { query: { month: Number(monthStart.slice(5, 7)), year: Number(monthStart.slice(0, 4)) } },
    );
    return res.items ?? [];
  } catch (err) {
    const status = statusOf(err);
    if (status === 401 || status === 403) {
      throw new CostSetupError(
        "This access policy token cannot read billed usage. Add the orgs:read scope (or org-billing-info:read) to its access policy.",
        SCOPE_HELP,
      );
    }
    if (status === 400 || status === 404) return [];
    throw err;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Split `total` across weights, rounded to cents, remainder on the largest
 * share. Weights that are all zero split evenly.
 */
export function splitAmount(total: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const sum = weights.reduce((a, b) => a + (b > 0 ? b : 0), 0);
  const raw = weights.map((w) =>
    sum > 0 ? (total * (w > 0 ? w : 0)) / sum : total / weights.length,
  );
  const rounded = raw.map(round2);
  const diff = round2(round2(total) - rounded.reduce((a, b) => a + b, 0));
  if (diff !== 0) {
    let largest = 0;
    for (let i = 1; i < raw.length; i++) if ((raw[i] ?? 0) > (raw[largest] ?? 0)) largest = i;
    rounded[largest] = round2((rounded[largest] ?? 0) + diff);
  }
  return rounded;
}

interface StackRef {
  slug: string;
  region?: string;
}

function stackIndex(stacks: GcStack[]): Map<number, StackRef> {
  const out = new Map<number, StackRef>();
  for (const s of stacks) {
    if (s.id === undefined || !s.slug) continue;
    out.set(s.id, { slug: s.slug, ...(s.regionSlug ? { region: s.regionSlug } : {}) });
  }
  return out;
}

/** Billed-usage items for one month → cost rows dated to `monthStart`. */
export function rowsForMonth(
  monthStart: string,
  items: GcBilledUsage[],
  stacks: Map<number, StackRef>,
): CostRow[] {
  const rows: CostRow[] = [];
  for (const item of items) {
    const service = item.dimensionName || item.dimensionId || "Other";
    const amountDue = typeof item.amountDue === "number" ? item.amountDue : 0;
    const unit = item.unit || undefined;
    const usages = (item.usages ?? []).filter(
      (u) => (u.totalUsage ?? 0) > 0 || (u.attributedCost ?? 0) !== 0,
    );
    if (usages.length === 0) {
      if (amountDue === 0 && !(item.totalUsage ?? 0)) continue;
      rows.push({
        date: monthStart,
        service,
        currency: CURRENCY,
        amount: round2(amountDue),
        ...(typeof item.totalUsage === "number" ? { usageAmount: item.totalUsage } : {}),
        ...(unit ? { usageUnit: unit } : {}),
      });
      continue;
    }
    const attributed = usages.map((u) => u.attributedCost ?? 0);
    const useAttributed = attributed.some((a) => a !== 0);
    const amounts = splitAmount(
      amountDue,
      useAttributed ? attributed : usages.map((u) => u.totalUsage ?? 0),
    );
    usages.forEach((u, i) => {
      const ref = u.stackId !== undefined ? stacks.get(u.stackId) : undefined;
      const slug = ref?.slug ?? (u.stackName ?? "").replace(/\.grafana\.net$/, "");
      rows.push({
        date: monthStart,
        service,
        ...(ref?.region ? { region: ref.region } : {}),
        ...(slug ? { resourceId: slug, tags: { stack: slug } } : {}),
        currency: CURRENCY,
        amount: amounts[i] ?? 0,
        ...(typeof u.totalUsage === "number" ? { usageAmount: u.totalUsage } : {}),
        ...(unit ? { usageUnit: unit } : {}),
      });
    });
  }
  return aggregateRows(rows);
}

/** Merge rows that share every dimension (two dimensions can share a name). */
export function aggregateRows(rows: CostRow[]): CostRow[] {
  const byKey = new Map<string, CostRow>();
  for (const row of rows) {
    const key = [row.date, row.service, row.region, row.resourceId, row.usageUnit].join("|");
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...row });
      continue;
    }
    existing.amount = round2(existing.amount + row.amount);
    if (row.usageAmount !== undefined) {
      existing.usageAmount = (existing.usageAmount ?? 0) + row.usageAmount;
    }
  }
  return [...byKey.values()];
}

export async function fetchGrafanaCostData(
  ctx: GrafanaContext,
  orgSlugCredential: string,
  range: CostFetchRange,
  now: Date = new Date(),
): Promise<CostRow[]> {
  const today = now.toISOString().slice(0, 10);
  const months = monthStartsInRange(range.fromDate, range.toDate, today);
  if (months.length === 0) return [];
  const slug = await orgSlugOf(ctx, orgSlugCredential);
  const stacks = stackIndex(await listStacks(ctx, orgSlugCredential).catch(() => []));
  const rows: CostRow[] = [];
  for (const month of months) {
    rows.push(...rowsForMonth(month, await fetchBilledUsage(ctx, slug, month), stacks));
  }
  return rows;
}

/** The current month's bill, for the organization detail view and card. */
export interface GrafanaBillSummary {
  month: string;
  total: number;
  products: Array<{
    product: string;
    unit: string;
    usage?: number;
    included?: number;
    overage?: number;
    amount: number;
  }>;
  stacks: Array<{ stack: string; amount: number }>;
}

export async function fetchBillSummary(
  ctx: GrafanaContext,
  orgSlugCredential: string,
  now: Date = new Date(),
): Promise<GrafanaBillSummary> {
  const month = `${now.toISOString().slice(0, 7)}-01`;
  const slug = await orgSlugOf(ctx, orgSlugCredential);
  const items = await fetchBilledUsage(ctx, slug, month);
  const stacks = stackIndex(await listStacks(ctx, orgSlugCredential).catch(() => []));
  const byStack = new Map<string, number>();
  for (const row of rowsForMonth(month, items, stacks)) {
    if (!row.resourceId) continue;
    byStack.set(row.resourceId, round2((byStack.get(row.resourceId) ?? 0) + row.amount));
  }
  const products = items
    .map((i) => ({
      product: i.dimensionName || i.dimensionId || "Other",
      unit: i.unit ?? "",
      ...(typeof i.totalUsage === "number" ? { usage: i.totalUsage } : {}),
      ...(typeof i.includedUsage === "number" ? { included: i.includedUsage } : {}),
      ...(typeof i.overage === "number" ? { overage: i.overage } : {}),
      amount: round2(i.amountDue ?? 0),
    }))
    .sort((a, b) => b.amount - a.amount || a.product.localeCompare(b.product));
  return {
    month: month.slice(0, 7),
    total: round2(products.reduce((a, p) => a + p.amount, 0)),
    products,
    stacks: [...byStack.entries()]
      .map(([stack, amount]) => ({ stack, amount }))
      .sort((a, b) => b.amount - a.amount),
  };
}
