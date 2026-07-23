/**
 * Actual-spend collection via DigitalOcean's Billing Insights endpoint.
 *
 * `GET /v2/billing/{account_urn}/insights/{start_date}/{end_date}` returns
 * DAILY usage deltas derived from nightly invoice-item estimates — one data
 * point per (day, sku, description, region) with a USD `total_amount`. The
 * window is capped at 31 days per request, which matches the host's
 * month-aligned chunking, and data only exists from 1 December 2025 onward
 * (earlier windows come back empty). Because the points are nightly
 * estimates, daily sums can drift slightly from the month-end invoice; DO
 * recommends invoices for final amounts.
 *
 * The account URN (`do:team:{uuid}`) is not a credential — it is discovered
 * per collection from `/v2/account`, whose `team.uuid` identifies the team
 * context the API token belongs to. Requires the `billing:read` token scope
 * (per the endpoint's security declaration in digitalocean/openapi); the
 * account lookup needs `account:read`, which read tokens carry already.
 */

import type { CostFetchRange, CostRow } from "@infrawrench/plugin-base";

/** The client's private `fetch`, bound and passed in (same shape as DoCreateContext). */
export interface DoCostFetchContext {
  fetch<T>(path: string, options?: RequestInit): Promise<T>;
}

interface DoBillingDataPoint {
  usage_team_urn?: string;
  /** YYYY-MM-DD day the delta applies to. */
  start_date?: string;
  /** USD amount as a decimal string, e.g. "12.45". */
  total_amount?: string;
  region?: string;
  sku?: string;
  /** Invoice line description, e.g. "droplet name (c-2-4GiB)". */
  description?: string;
  /** Invoice item group, e.g. the DOKS cluster name. Blank when ungrouped. */
  group_description?: string;
}

interface DoBillingInsightsResponse {
  data_points?: DoBillingDataPoint[] | null;
  total_pages?: number;
  current_page?: number;
}

export async function fetchDoCostData(
  ctx: DoCostFetchContext,
  range: CostFetchRange,
): Promise<CostRow[]> {
  // Discover the account URN the token is scoped to. All current DO tokens
  // are team-scoped; a missing team block means a legacy personal context
  // the insights endpoint cannot address.
  const account = await ctx.fetch<{ account?: { team?: { uuid?: string } } }>("/account");
  const teamUuid = account.account?.team?.uuid;
  if (!teamUuid) {
    throw new Error(
      "DigitalOcean plugin: /v2/account returned no team context, so the account URN for " +
        "the Billing Insights endpoint cannot be derived. Billing collection requires a " +
        "team-scoped API token (all tokens minted since DO's teams migration are).",
    );
  }
  const urn = `do:team:${teamUuid}`;

  // Aggregate per (day, service, region) so re-fetching a day reproduces the
  // same dimension keys for the host's dedupe. `service` is the invoice item
  // group when present (collapses e.g. per-node DOKS lines under the cluster
  // name), else the line description. SKU is intentionally not a dimension —
  // it's an opaque billing code the user shouldn't have to know.
  const buckets = new Map<
    string,
    { date: string; service: string; region: string; amount: number }
  >();

  let page = 1;
  let totalPages = 1;
  do {
    let data: DoBillingInsightsResponse;
    try {
      data = await ctx.fetch<DoBillingInsightsResponse>(
        `/billing/${urn}/insights/${range.fromDate}/${range.toDate}?per_page=200&page=${page}`,
      );
    } catch (err) {
      // Windows entirely before the 2025-12-01 data start can 404 rather
      // than return an empty list — treat that as "no data" so the host's
      // historical backfill doesn't hard-fail. Other errors (401 missing
      // `billing:read` scope, 429, 5xx) propagate with status + body via
      // jsonRestFetch's error message.
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes(" 404 ")) return [];
      throw err;
    }

    for (const point of data.data_points ?? []) {
      const date = point.start_date ?? "";
      if (!date) continue;
      const amount = Number(point.total_amount ?? "0");
      if (!Number.isFinite(amount) || amount === 0) continue;
      const service = point.group_description || point.description || point.sku || "";
      const region = point.region ?? "";

      const key = `${date}|${service}|${region}`;
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.amount += amount;
      } else {
        buckets.set(key, { date, service, region, amount });
      }
    }

    totalPages = Math.max(1, Number(data.total_pages ?? 1));
    page += 1;
  } while (page <= totalPages);

  const rows: CostRow[] = [];
  for (const b of buckets.values()) {
    if (b.amount === 0) continue;
    rows.push({
      date: b.date,
      service: b.service,
      region: b.region,
      currency: "USD",
      amount: b.amount,
    });
  }
  return rows;
}
