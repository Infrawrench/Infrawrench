/**
 * Daily cost rows from the enhanced billing platform's usage report.
 *
 * Each line item carries what GitHub actually billed: a gross amount at the
 * SKU's price, the discount applied to it (the minutes, storage and seats a
 * plan includes, plus any negotiated discount) and the net. The plugin writes
 * the gross as a `usage` row and the discount as a separate negative `credit`
 * row, so totals equal the net bill to the cent while "how much would this
 * have cost without the included allowance" stays visible by charge type.
 *
 * Dimensions: product as the service (Actions, Copilot, Codespaces, Packages,
 * Git LFS, Advanced Security…), the repository as the resource id where the
 * line has one (it matches the Actions cache resource's id, so per-repository
 * spend lands on that resource), and tags for the SKU, the organization (on
 * an enterprise bill) and the cost centre.
 */

import type { CostFetchRange, CostRow } from "@infrawrench/plugin-base";
import { CostSetupError } from "@infrawrench/plugin-base";
import type { GitHubContext } from "./api.js";
import { statusOf } from "./api.js";
import { normalizeId, productLabel } from "./products.js";
import type { TaggedUsageItem } from "./usage.js";
import { fetchCostCenters, fetchMonthItems, isoDay, monthsBetween } from "./usage.js";

const CURRENCY = "USD";

function setupLink(ctx: GitHubContext): { label: string; url: string } {
  return ctx.owner.kind === "org"
    ? {
        label: "Organization billing",
        url: `${ctx.host.webUrl}/organizations/${encodeURIComponent(ctx.owner.slug)}/settings/billing`,
      }
    : {
        label: "Enterprise billing",
        url: `${ctx.host.webUrl}/enterprises/${encodeURIComponent(ctx.owner.slug)}/billing`,
      };
}

/** Turn the API's refusals into a message the user can act on. */
export function costSetupErrorFor(ctx: GitHubContext, err: unknown): Error {
  const status = statusOf(err);
  const who = ctx.owner.kind === "org" ? "organization" : "enterprise";
  if (status === 401) {
    return new CostSetupError(
      "GitHub rejected the token. It may have expired or been revoked; update it with Edit credentials.",
      setupLink(ctx),
    );
  }
  if (status === 403) {
    return new CostSetupError(
      ctx.owner.kind === "org"
        ? `The token cannot read ${ctx.owner.slug}'s billing usage. A fine-grained token needs the organization permission Administration (read), and its owner must be an organization owner or billing manager. A classic token needs the admin:org scope.`
        : `The token cannot read the ${ctx.owner.slug} enterprise's billing usage. Enterprise billing needs a classic token with the manage_billing:enterprise scope (fine-grained tokens cannot reach enterprise endpoints), owned by an enterprise owner or billing manager.`,
      setupLink(ctx),
    );
  }
  if (status === 404) {
    return new CostSetupError(
      `GitHub has no billing usage for the ${who} ${ctx.owner.slug}. Check the name, and that the ${who} is on the enhanced billing platform: the usage API is only available there.`,
      {
        label: "About the enhanced billing platform",
        url: "https://docs.github.com/billing/using-the-new-billing-platform",
      },
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

function rowKey(item: TaggedUsageItem, date: string): string {
  return JSON.stringify([
    date,
    normalizeId(item.product),
    normalizeId(item.sku),
    item.organizationName ?? "",
    item.repositoryName ?? "",
    item.costCenter ?? "",
    item.unitType ?? "",
  ]);
}

/**
 * Fold line items into cost rows, one usage row and (when discounted) one
 * credit row per day + product + SKU + organization + repository + cost
 * centre. Items outside the range are dropped.
 */
export function toCostRows(
  items: TaggedUsageItem[],
  range: CostFetchRange,
  includeOrganization: boolean,
): CostRow[] {
  const acc = new Map<
    string,
    { item: TaggedUsageItem; date: string; gross: number; discount: number; quantity: number }
  >();
  for (const item of items) {
    const date = isoDay(item.date);
    if (!date || date < range.fromDate || date > range.toDate) continue;
    const key = rowKey(item, date);
    const cur = acc.get(key) ?? { item, date, gross: 0, discount: 0, quantity: 0 };
    // Older payloads omit gross on zero-priced lines; fall back to net + discount.
    const discount = item.discountAmount ?? 0;
    const gross = item.grossAmount ?? (item.netAmount ?? 0) + discount;
    cur.gross += gross;
    cur.discount += discount;
    cur.quantity += item.quantity ?? 0;
    acc.set(key, cur);
  }
  const rows: CostRow[] = [];
  for (const { item, date, gross, discount, quantity } of acc.values()) {
    const tags: Record<string, string> = {};
    const sku = normalizeId(item.sku);
    if (sku) tags["sku"] = sku;
    if (includeOrganization && item.organizationName) tags["organization"] = item.organizationName;
    if (item.costCenter) tags["costCenter"] = item.costCenter;
    const base = {
      date,
      service: productLabel(item.product, item.sku),
      ...(item.repositoryName ? { resourceId: item.repositoryName } : {}),
      ...(Object.keys(tags).length > 0 ? { tags } : {}),
      currency: CURRENCY,
    };
    if (gross !== 0 || quantity !== 0) {
      rows.push({
        ...base,
        amount: round6(gross),
        chargeType: "usage",
        ...(quantity ? { usageAmount: round6(quantity) } : {}),
        ...(item.unitType ? { usageUnit: item.unitType } : {}),
      });
    }
    if (discount !== 0) {
      rows.push({ ...base, amount: round6(-discount), chargeType: "credit" });
    }
  }
  return rows;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export async function fetchGitHubCostData(
  ctx: GitHubContext,
  range: CostFetchRange,
): Promise<CostRow[]> {
  try {
    const centers =
      ctx.owner.kind === "enterprise" ? await fetchCostCenters(ctx).catch(() => []) : [];
    const rows: CostRow[] = [];
    const months = monthsBetween(range.fromDate, range.toDate);
    // Newest first, so a refusal is judged on the month that must exist.
    for (const [index, ym] of [...months].reverse().entries()) {
      let items: TaggedUsageItem[];
      try {
        items = await fetchMonthItems(ctx, ym, centers);
      } catch (err) {
        // A backfill reaching past the start of the account's enhanced
        // billing history is refused with a 400/404 for those months; skip
        // them rather than losing the months that do exist.
        const status = statusOf(err);
        if (index > 0 && (status === 400 || status === 404 || status === 422)) continue;
        throw err;
      }
      rows.push(...toCostRows(items, range, ctx.owner.kind === "enterprise"));
    }
    return rows;
  } catch (err) {
    throw costSetupErrorFor(ctx, err);
  }
}
