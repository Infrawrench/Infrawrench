/**
 * Presentation of the plugins' forward-looking cost estimates
 * (`PluginClient.estimateCost`), shared by every surface that quotes one:
 * the create form's running total, the edit modal's "+$340/month" delta, and
 * the resource detail page's standing estimate — on web, desktop, and mobile.
 *
 * It lives in client-core rather than in `@infrawrench/ui` for the usual
 * reason: mobile needs the same numbers rendered by native components, and a
 * second copy of the rounding rules is a second place for them to drift.
 *
 * These deliberately do *not* reuse `formatMoney` from `./costs`. That one
 * formats reported spend, where whole dollars are the readable choice above
 * $10 — but an estimate's cents are the whole point when the user is watching
 * the figure move as they drag a disk slider, and rounding a $30.37 instance
 * to "$30" makes a $0.37/GB storage change look like it did nothing.
 */
import type { CostEstimate } from "@infrawrench/plugin-base";

import type { CloudFetch } from "./fetch";

const formatterCache = new Map<string, Intl.NumberFormat>();

function currencyFormatter(currency: string, fractionDigits: number): Intl.NumberFormat {
  const key = `${currency}:${fractionDigits}`;
  let fmt = formatterCache.get(key);
  if (!fmt) {
    try {
      fmt = new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: currency || "USD",
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits,
      });
    } catch {
      fmt = new Intl.NumberFormat(undefined, {
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits,
      });
    }
    formatterCache.set(key, fmt);
  }
  return fmt;
}

/**
 * A monthly figure: `$30.37`, `$1,109.60`, `$12`. Cents are shown whenever
 * there are any, and dropped when there are none so a round number reads as
 * one.
 */
export function formatMonthlyEstimate(amount: number, currency = "USD"): string {
  return currencyFormatter(currency, amount % 1 === 0 ? 0 : 2).format(amount);
}

/**
 * A signed monthly change: `+$340.00`, `−$12.50`, `no change`.
 *
 * The minus is U+2212, not a hyphen — it aligns with digits, which matters
 * when a column of these sits under a total.
 */
export function formatMonthlyDelta(delta: number, currency = "USD"): string {
  if (delta === 0) return "no change";
  const magnitude = formatMonthlyEstimate(Math.abs(delta), currency);
  return delta > 0 ? `+${magnitude}` : `−${magnitude}`;
}

/**
 * The sentence a host shows beside a proposed edit: "This change adds
 * $340/month". Null when there is nothing worth saying — no delta available,
 * or a change that moves the bill by less than a cent.
 */
export function describeMonthlyDelta(delta: number | null, currency = "USD"): string | null {
  if (delta === null || Math.abs(delta) < 0.01) return null;
  const magnitude = formatMonthlyEstimate(Math.abs(delta), currency);
  return delta > 0 ? `This change adds ${magnitude}/month` : `This change saves ${magnitude}/month`;
}

/**
 * How to label a total that the plugin flagged as covering only part of the
 * resource — "at least $30.37/mo" rather than "$30.37/mo", because quoting a
 * floor as if it were the whole bill is exactly the failure the `partial`
 * flag exists to prevent. Null when the estimate is complete.
 */
export function partialEstimatePrefix(estimate: CostEstimate | null | undefined): string | null {
  return estimate?.partial ? "at least" : null;
}

/**
 * Fetch a resource's standing monthly estimate from the cloud API. Mobile
 * uses this directly; web and desktop have their own transports but hit the
 * same route with the same body.
 *
 * Best-effort: an org whose plugin can't price the type gets `null`, which is
 * the same answer a failed request gives, because in both cases there is no
 * figure to show.
 */
export async function fetchResourceCostEstimate(
  api: CloudFetch,
  orgId: string,
  input: { accountId: string; resourceTypeId: string; resourceId: string },
): Promise<CostEstimate | null> {
  const result = await api.org<{ estimate: CostEstimate | null }>(
    orgId,
    `/resources/cost-estimate`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
  return result?.estimate ?? null;
}
