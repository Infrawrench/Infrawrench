/**
 * Cost from Better Stack's usage API (`https://betterstack.com/api/v2/usage`,
 * global API token only): the overview lists every product the organization
 * pays for, and `GET /api/v2/usage/{product}?dimension=cost&resolution=day`
 * returns one item per billed thing (a source, a monitor plan, responder
 * licenses…) with a value per day. That is the same data as the Usage page,
 * in dollars, so rows are not estimates. The current day is reported
 * `finalized: false` and restated on later passes.
 */
import type { CostFetchRange, CostRow } from "@infrawrench/plugin-base";
import { CostSetupError } from "@infrawrench/plugin-base";
import type { BetterStackContext } from "./api.js";
import { bsFetch, mapPooled, statusOf } from "./api.js";

interface UsageProduct {
  id: string;
  attributes?: { name?: string; cost?: number };
}

interface UsageItem {
  id: string;
  attributes?: {
    name?: string;
    values?: Array<{ date?: string; date_from?: string; value?: number }>;
  };
}

const MAX_RANGE_DAYS = 400;

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Split an inclusive range into chunks of at most 400 days. */
export function chunks(range: CostFetchRange): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  let from = range.fromDate;
  while (from <= range.toDate) {
    const end = addDays(from, MAX_RANGE_DAYS - 1);
    const to = end < range.toDate ? end : range.toDate;
    out.push({ from, to });
    from = addDays(to, 1);
  }
  return out;
}

export async function fetchBetterStackCost(
  ctx: BetterStackContext,
  range: CostFetchRange,
): Promise<CostRow[]> {
  const rows: CostRow[] = [];
  for (const chunk of chunks(range)) {
    let products: UsageProduct[];
    try {
      products =
        (await bsFetch<{ data?: UsageProduct[] }>(ctx, "main", "/api/v2/usage", { query: chunk }))
          .data ?? [];
    } catch (err) {
      const status = statusOf(err);
      if (status === 401 || status === 403) {
        throw new CostSetupError(
          "Better Stack's usage API needs a global API token. Create one under Better Stack, API tokens, Global API tokens, and use it for this account.",
          {
            label: "Create a global API token",
            url: "https://betterstack.com/settings/global-api-tokens",
          },
        );
      }
      throw err;
    }
    const perProduct = await mapPooled(products, 3, async (p) => {
      const res = await bsFetch<{ data?: UsageItem[] }>(
        ctx,
        "main",
        `/api/v2/usage/${encodeURIComponent(p.id)}`,
        {
          query: { ...chunk, dimension: "cost", resolution: "day" },
        },
      );
      return { product: p, items: res.data ?? [] };
    });
    for (const { product, items } of perProduct) {
      const service = product.attributes?.name ?? product.id;
      for (const item of items) {
        for (const v of item.attributes?.values ?? []) {
          const date = v.date ?? v.date_from;
          if (!date || typeof v.value !== "number" || v.value === 0) continue;
          if (date < range.fromDate || date > range.toDate) continue;
          rows.push({
            date,
            service,
            resourceId: `${product.id}/${item.id}`,
            tags: { item: item.attributes?.name ?? item.id },
            currency: "USD",
            amount: v.value,
          });
        }
      }
    }
  }
  return rows;
}
